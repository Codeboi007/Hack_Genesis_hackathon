from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any

import redis.asyncio as redis
from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from backend.models.schemas import (
    DocsResponse,
    HealthResponse,
    JobStatus,
    RepoInput,
    TokenVerifyInput,
    TokenVerifyResponse,
    ReviewResponse,
    WebhookAck,
)
from backend.services.doc_service import DocumentationService
from backend.services.ingestion import (
    IngestionError,
    cleanup_workspace,
    create_workspace,
    ingest_from_url,
    ingest_zip_bytes,
)
from backend.services.review_service import ReviewService
from backend.services.token_crypto import decrypt_token, encrypt_token
from backend.utils.settings import settings
from docs.parser import parse_repository
from docs.repo_loader import iter_code_files
from github.commenter import (
    format_inline_comments,
    post_pr_review,
    push_readme_to_github,
    verify_docs_token_access,
)
from github.diff_fetcher import GitHubDiffError, fetch_pr_diff
from github.pr_handler import build_virtual_files_from_diff
from github.webhook import SignatureValidationError, validate_github_signature
from rag.rag_pipeline import RAGPipeline

# ── App setup ─────────────────────────────────────────────────────────────────

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)

app = FastAPI(title="AI Developer Platform API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.cors_origins),
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Services & state ──────────────────────────────────────────────────────────

rag_pipeline = RAGPipeline()
review_service = ReviewService(rag_pipeline)
doc_service = DocumentationService(rag_pipeline)
redis_client = redis.from_url(
    os.getenv("REDIS_URL", "redis://localhost:6379/0"),
    decode_responses=True,
)

RUN_CACHE: dict[str, dict[str, Any]] = {}
JOBS_FALLBACK: dict[str, dict[str, Any]] = {}
JOB_KEY_PREFIX = "jobs:"
JOB_TTL_SECONDS = int(os.getenv("JOB_TTL_SECONDS", "86400"))
JOB_PHASE_TIMEOUT_SECONDS = settings.job_phase_timeout_seconds
JOB_STALE_TIMEOUT_SECONDS = max(settings.job_stale_timeout_seconds, JOB_PHASE_TIMEOUT_SECONDS)


@app.on_event("startup")
async def on_startup() -> None:
    logger.info(
        "Server started | host=%s port=%s keep_workspaces=%s nim_enabled=%s models=[%s, %s, %s]",
        settings.backend_host,
        settings.backend_port,
        settings.keep_workspaces,
        bool(settings.nim_api_key),
        settings.nim_model_neotron,
        settings.nim_model_qwen_docs,
        settings.nim_model_qwen_review,
    )


@app.on_event("shutdown")
async def on_shutdown() -> None:
    await redis_client.aclose()


@app.middleware("http")
async def request_timing_middleware(request: Request, call_next):
    start = time.perf_counter()
    logger.info("API call started | method=%s path=%s", request.method, request.url.path)
    try:
        response = await call_next(request)
        elapsed_ms = int((time.perf_counter() - start) * 1000)
        logger.info(
            "API call completed | method=%s path=%s status=%s elapsed_ms=%d",
            request.method,
            request.url.path,
            response.status_code,
            elapsed_ms,
        )
        return response
    except Exception:
        elapsed_ms = int((time.perf_counter() - start) * 1000)
        logger.exception(
            "API call failed | method=%s path=%s elapsed_ms=%d",
            request.method,
            request.url.path,
            elapsed_ms,
        )
        raise


# ── Global exception handler ──────────────────────────────────────────────────

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    logger.exception("Unhandled exception on %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=500,
        content={"detail": f"Internal server error: {type(exc).__name__}: {exc}"},
    )


# ── Health ────────────────────────────────────────────────────────────────────

@app.get("/api/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(
        status="ok",
        cache_runs=len(RUN_CACHE),
        rag_chunks=len(rag_pipeline.store.items),
    )


# ── Job polling ───────────────────────────────────────────────────────────────

@app.get("/api/jobs/{job_id}", response_model=JobStatus)
async def get_job_status(job_id: str) -> JobStatus:
    """Poll this endpoint until status == 'done' or 'error'."""
    job = await _get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"Job {job_id!r} not found")

    if job.get("status") == "processing":
        updated_at = float(job.get("updated_at") or 0)
        age_seconds = time.time() - updated_at if updated_at else 0
        if updated_at and age_seconds > JOB_STALE_TIMEOUT_SECONDS:
            msg = (
                f"Job exceeded processing window ({JOB_STALE_TIMEOUT_SECONDS}s) and was marked failed. "
                "Please retry."
            )
            logger.warning("Job stale timeout | job_id=%s age_seconds=%d", job_id, int(age_seconds))
            await _set_job(job_id, "error", msg, None)
            job = await _get_job(job_id) or {"status": "error", "message": msg, "result": None}

    return JobStatus(
        job_id=job_id,
        status=job["status"],
        message=job.get("message", ""),
        result=job.get("result"),
    )


# ── Helpers ───────────────────────────────────────────────────────────────────

def _job_key(job_id: str) -> str:
    return f"{JOB_KEY_PREFIX}{job_id}"


async def _set_job(job_id: str, status: str, message: str = "", result: Any = None) -> None:
    now_ts = str(time.time())
    payload = {
        "status": status,
        "message": message,
        "result": json.dumps(result),
        "updated_at": now_ts,
    }
    key = _job_key(job_id)
    try:
        await redis_client.hset(key, mapping=payload)
        await redis_client.expire(key, JOB_TTL_SECONDS)
    except Exception:
        logger.exception("Redis write failed for job_id=%s; using process-local fallback", job_id)
        JOBS_FALLBACK[job_id] = {
            "status": status,
            "message": message,
            "result": result,
            "updated_at": float(now_ts),
        }


async def _get_job(job_id: str) -> dict[str, Any] | None:
    try:
        data = await redis_client.hgetall(_job_key(job_id))
    except Exception:
        logger.exception("Redis read failed for job_id=%s; checking process-local fallback", job_id)
        return JOBS_FALLBACK.get(job_id)

    if not data:
        return JOBS_FALLBACK.get(job_id)

    try:
        result = json.loads(data.get("result", "null"))
    except json.JSONDecodeError:
        result = None
    try:
        updated_at = float(data.get("updated_at", "0") or 0)
    except ValueError:
        updated_at = 0.0

    return {
        "status": data.get("status", "processing"),
        "message": data.get("message", ""),
        "result": result,
        "updated_at": updated_at,
    }


async def _run_with_job_timeout(awaitable, *, job_id: str, phase: str):
    try:
        return await asyncio.wait_for(awaitable, timeout=JOB_PHASE_TIMEOUT_SECONDS)
    except TimeoutError as exc:
        raise TimeoutError(
            f"{phase} exceeded timeout ({JOB_PHASE_TIMEOUT_SECONDS}s) for job {job_id}"
        ) from exc


def _parse_workspace(repo_root: Path) -> list[dict[str, Any]]:
    files = iter_code_files(repo_root)
    logger.info("Workspace scan complete | root=%s supported_files=%d", repo_root, len(files))
    if not files:
        raise HTTPException(status_code=400, detail="No supported source files found in repository")
    parsed = parse_repository(files)
    for item in parsed:
        raw_path = item.get("path", "")
        try:
            item["path"] = Path(raw_path).resolve().relative_to(repo_root.resolve()).as_posix()
        except Exception:
            item["path"] = Path(raw_path).name
    logger.info("Repository parse complete | parsed_files=%d", len(parsed))
    return parsed


def _extract_repo_name(repo_url: str) -> str | None:
    """Extract 'owner/repo' from a GitHub URL."""
    m = re.search(r"github\.com[:/]([\w.-]+/[\w.-]+)", repo_url)
    if not m:
        return None
    return m.group(1).removesuffix(".git")


# ── Background job workers ────────────────────────────────────────────────────

async def _job_review(job_id: str, persona: str, workspace: Path, repo_root: Path) -> None:
    try:
        logger.info("Job started | type=review job_id=%s persona=%s", job_id, persona)
        parsed_files = _parse_workspace(repo_root)
        await _set_job(job_id, "processing", "Review processing started", None)
        logger.info("Job phase | type=review job_id=%s phase=model_processing", job_id)
        result = await _run_with_job_timeout(
            review_service.review(parsed_files, persona),
            job_id=job_id,
            phase="review generation",
        )
        run_id = str(uuid.uuid4())
        response = ReviewResponse(run_id=run_id, persona=persona, **result)  # type: ignore[arg-type]
        RUN_CACHE[run_id] = response.model_dump()
        await _set_job(job_id, "done", "Review complete", response.model_dump())
        logger.info("Job completed | type=review job_id=%s run_id=%s", job_id, run_id)
    except Exception as exc:
        logger.exception("Job %s (review) failed: %s", job_id, exc)
        await _set_job(job_id, "error", str(exc), None)
    finally:
        if not settings.keep_workspaces:
            cleanup_workspace(workspace)


async def _job_docs(
    job_id: str,
    persona: str,
    workspace: Path,
    repo_root: Path,
    repo_full_name: str | None = None,
    encrypted_docs_token: str | None = None,
    docs_token: str | None = None,
) -> None:
    try:
        logger.info("Job started | type=docs job_id=%s persona=%s repo=%s", job_id, persona, repo_full_name or "upload")
        parsed_files = _parse_workspace(repo_root)
        await _set_job(job_id, "processing", "Docs processing started", None)
        logger.info("Job phase | type=docs job_id=%s phase=model_processing", job_id)
        result = await _run_with_job_timeout(
            doc_service.generate(parsed_files, persona),
            job_id=job_id,
            phase="docs generation",
        )
        run_id = str(uuid.uuid4())
        response = DocsResponse(run_id=run_id, persona=persona, **result)  # type: ignore[arg-type]
        RUN_CACHE[run_id] = response.model_dump()
        await _set_job(job_id, "done", "Docs generated", response.model_dump())
        logger.info("Job completed | type=docs job_id=%s run_id=%s", job_id, run_id)

        # Push README to GitHub using token priority:
        # request-scoped encrypted PAT -> env GITHUB_DOCS_TOKEN
        resolved_docs_token = docs_token or settings.github_docs_token
        if encrypted_docs_token:
            try:
                resolved_docs_token = decrypt_token(encrypted_docs_token)
            except ValueError:
                logger.warning("Invalid encrypted docs token payload for job %s", job_id)
        if repo_full_name and result.get("readme") and resolved_docs_token:
            pushed = push_readme_to_github(
                repo_full_name=repo_full_name,
                token=resolved_docs_token,
                readme_content=result["readme"],
            )
            logger.info("README push to %s: %s", repo_full_name, "OK" if pushed else "failed")
        elif repo_full_name and not settings.github_docs_token:
            logger.warning("GITHUB_DOCS_TOKEN not set — skipping README push to %s", repo_full_name)

    except Exception as exc:
        logger.exception("Job %s (docs) failed: %s", job_id, exc)
        await _set_job(job_id, "error", str(exc), None)
    finally:
        if not settings.keep_workspaces:
            cleanup_workspace(workspace)


# ── Review endpoints ──────────────────────────────────────────────────────────

@app.post("/api/review/repo", response_model=JobStatus)
async def review_repo(payload: RepoInput, background_tasks: BackgroundTasks) -> JobStatus:
    logger.info("API payload accepted | endpoint=/api/review/repo repo_url=%s persona=%s", payload.repo_url, payload.persona)
    workspace = create_workspace()
    try:
        repo_root = ingest_from_url(payload.repo_url, workspace, github_token=settings.github_review_token)
    except IngestionError as exc:
        cleanup_workspace(workspace)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    job_id = str(uuid.uuid4())
    await _set_job(job_id, "processing", "Review queued", None)
    background_tasks.add_task(_job_review, job_id, payload.persona, workspace, repo_root)
    logger.info("Job queued | type=review source=repo job_id=%s", job_id)
    return JobStatus(job_id=job_id, status="processing", message="Review queued — poll /api/jobs/{job_id}")


@app.post("/api/review/upload", response_model=JobStatus)
async def review_upload(
    background_tasks: BackgroundTasks,
    persona: str = Form(...),
    file: UploadFile = File(...),
) -> JobStatus:
    logger.info("API payload accepted | endpoint=/api/review/upload persona=%s filename=%s", persona, file.filename)
    blob = await file.read()
    workspace = create_workspace()
    try:
        repo_root = ingest_zip_bytes(blob, workspace)
    except IngestionError as exc:
        cleanup_workspace(workspace)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    job_id = str(uuid.uuid4())
    await _set_job(job_id, "processing", "Review queued", None)
    background_tasks.add_task(_job_review, job_id, persona, workspace, repo_root)
    logger.info("Job queued | type=review source=upload job_id=%s", job_id)
    return JobStatus(job_id=job_id, status="processing", message="Review queued — poll /api/jobs/{job_id}")


# ── Docs endpoints ────────────────────────────────────────────────────────────

@app.post("/api/docs/repo", response_model=JobStatus)
async def docs_repo(payload: RepoInput, background_tasks: BackgroundTasks) -> JobStatus:
    logger.info("API payload accepted | endpoint=/api/docs/repo repo_url=%s persona=%s", payload.repo_url, payload.persona)
    workspace = create_workspace()
    try:
        repo_root = ingest_from_url(payload.repo_url, workspace, github_token=settings.github_review_token)
    except IngestionError as exc:
        cleanup_workspace(workspace)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    repo_full_name = _extract_repo_name(payload.repo_url)
    job_id = str(uuid.uuid4())
    await _set_job(job_id, "processing", "Docs generation queued", None)
    background_tasks.add_task(
        _job_docs,
        job_id,
        payload.persona,
        workspace,
        repo_root,
        repo_full_name,
        payload.encrypted_docs_token,
        payload.docs_token,
    )
    logger.info("Job queued | type=docs source=repo job_id=%s repo=%s", job_id, repo_full_name or "unknown")
    msg = f"Docs queued — README will be pushed to {repo_full_name}" if repo_full_name else "Docs queued"
    return JobStatus(job_id=job_id, status="processing", message=msg)


@app.post("/api/github/verify-docs-token", response_model=TokenVerifyResponse)
def verify_docs_token(payload: TokenVerifyInput) -> TokenVerifyResponse:
    repo_full_name = _extract_repo_name(payload.repo_url)
    if not repo_full_name:
        raise HTTPException(status_code=400, detail="Invalid GitHub repository URL")

    valid, default_branch, message = verify_docs_token_access(repo_full_name, payload.token)
    if not valid:
        return TokenVerifyResponse(
            valid=False,
            repo_full_name=repo_full_name,
            default_branch=default_branch or None,
            message=message,
        )

    return TokenVerifyResponse(
        valid=True,
        repo_full_name=repo_full_name,
        default_branch=default_branch or None,
        encrypted_token=encrypt_token(payload.token),
        message=message,
    )


@app.post("/api/docs/upload", response_model=JobStatus)
async def docs_upload(
    background_tasks: BackgroundTasks,
    persona: str = Form(...),
    file: UploadFile = File(...),
) -> JobStatus:
    logger.info("API payload accepted | endpoint=/api/docs/upload persona=%s filename=%s", persona, file.filename)
    blob = await file.read()
    workspace = create_workspace()
    try:
        repo_root = ingest_zip_bytes(blob, workspace)
    except IngestionError as exc:
        cleanup_workspace(workspace)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    job_id = str(uuid.uuid4())
    await _set_job(job_id, "processing", "Docs generation queued", None)
    background_tasks.add_task(_job_docs, job_id, persona, workspace, repo_root)
    logger.info("Job queued | type=docs source=upload job_id=%s", job_id)
    return JobStatus(job_id=job_id, status="processing", message="Docs queued — poll /api/jobs/{job_id}")


# ── GitHub webhook ────────────────────────────────────────────────────────────

async def _run_pr_review_background(
    repo_name: str,
    pr_number: int,
    run_id: str,
) -> None:
    """Background task: fetch diff → review → post comments."""
    try:
        diff_text = fetch_pr_diff(repo_name, pr_number, settings.github_review_token)
    except GitHubDiffError as exc:
        logger.warning("PR review: diff fetch failed for %s#%d: %s", repo_name, pr_number, exc)
        return

    parsed_files = build_virtual_files_from_diff(diff_text)
    if not parsed_files:
        logger.info("PR review: no reviewable files in diff for %s#%d", repo_name, pr_number)
        return

    try:
        result = await review_service.review_pr_fast(parsed_files, persona="Backend Developer")
    except Exception as exc:
        logger.exception("PR review: review_service failed for %s#%d: %s", repo_name, pr_number, exc)
        return

    RUN_CACHE[run_id] = {
        "type": "github_pr_review",
        "repo": repo_name,
        "pr_number": pr_number,
        "review": result,
        "comments": format_inline_comments(result["findings"]),
    }

    posted = post_pr_review(
        repo_full_name=repo_name,
        pr_number=pr_number,
        token=settings.github_review_token,
        findings=result["findings"],
        summary=result.get("summary", ""),
    )
    logger.info(
        "PR review done for %s#%d — %d findings, posted: %s",
        repo_name, pr_number, len(result["findings"]), posted,
    )


@app.post("/api/github/webhook", response_model=WebhookAck)
async def github_webhook(request: Request, background_tasks: BackgroundTasks) -> WebhookAck:
    raw_body = await request.body()
    signature = request.headers.get("X-Hub-Signature-256")
    event = request.headers.get("X-GitHub-Event", "")

    try:
        validate_github_signature(raw_body, settings.github_webhook_secret, signature)
    except SignatureValidationError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc

    try:
        payload = json.loads(raw_body.decode("utf-8"))
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON payload")

    if event != "pull_request":
        return WebhookAck(accepted=True, action="ignored", message=f"Event {event!r} ignored")

    action = payload.get("action", "")
    if action not in {"opened", "synchronize", "reopened"}:
        return WebhookAck(accepted=True, action="ignored", message=f"Action {action!r} ignored")

    pr = payload.get("pull_request", {})
    repo = payload.get("repository", {})
    repo_name = repo.get("full_name")
    pr_number = pr.get("number")

    if not repo_name or not pr_number:
        raise HTTPException(status_code=400, detail="Invalid pull_request payload")

    if not settings.github_review_token:
        logger.warning("GITHUB_REVIEW_TOKEN not set — cannot post PR review for %s#%d", repo_name, pr_number)
        return WebhookAck(accepted=True, action="ignored", message="No review token configured")

    run_id = str(uuid.uuid4())
    background_tasks.add_task(_run_pr_review_background, repo_name, pr_number, run_id)

    return WebhookAck(
        accepted=True,
        action=action,
        message="PR queued for review — comment will appear shortly.",
        run_id=run_id,
    )
