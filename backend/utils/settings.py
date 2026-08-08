from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / ".env")


def _normalize_origin(origin: str) -> str:
    return origin.strip().rstrip("/")


def _parse_cors_origins(raw: str) -> tuple[str, ...]:
    origins = {_normalize_origin(x) for x in raw.split(",") if x.strip()}
    expanded = set(origins)

    # Dev convenience: if localhost is allowed, allow 127.0.0.1 equivalent, and vice versa.
    for origin in origins:
        if "localhost" in origin:
            expanded.add(origin.replace("localhost", "127.0.0.1"))
        if "127.0.0.1" in origin:
            expanded.add(origin.replace("127.0.0.1", "localhost"))

    return tuple(sorted(expanded))


def _int_env(name: str, default: int, minimum: int | None = None) -> int:
    raw = os.getenv(name, "").strip()
    try:
        value = int(raw) if raw else default
    except ValueError:
        value = default
    if minimum is not None and value < minimum:
        return minimum
    return value


def _bool_env(name: str, default: bool) -> bool:
    raw = os.getenv(name, "").strip().lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "on"}


def _str_env(name: str, default: str) -> str:
    raw = os.getenv(name, "").strip()
    return raw if raw else default


@dataclass(frozen=True)
class Settings:
    backend_host: str = os.getenv("BACKEND_HOST", "0.0.0.0")
    backend_port: int = int(os.getenv("BACKEND_PORT", "8000"))

    cors_origins: tuple[str, ...] = _parse_cors_origins(os.getenv("CORS_ORIGINS", "http://localhost:3000"))

    # Webhook signature validation (leave blank to skip)
    github_webhook_secret: str = os.getenv("GITHUB_WEBHOOK_SECRET", "")

    # Token for posting PR review comments (fine-grained PAT: Pull requests R/W)
    github_review_token: str = os.getenv("GITHUB_REVIEW_TOKEN", "")

    # Token for pushing README commits (fine-grained PAT: Contents R/W)
    github_docs_token: str = os.getenv("GITHUB_DOCS_TOKEN", "")
    token_encryption_secret: str = os.getenv("TOKEN_ENCRYPTION_SECRET", "")

    keep_workspaces: bool = os.getenv("KEEP_WORKSPACES", "false").strip().lower() == "true"

    nim_api_key: str = os.getenv("NIM_API_KEY", "")

    # Pool keys — all four are round-robined across every LLM call so each
    # feature (review / docs / structure) spreads load across all keys.
    # Leave blank any keys you don't have; the pool uses whichever are set.
    nim_api_key_1: str = os.getenv("NIM_API_KEY_1", "")
    nim_api_key_2: str = os.getenv("NIM_API_KEY_2", "")
    nim_api_key_3: str = os.getenv("NIM_API_KEY_3", "")
    nim_api_key_4: str = os.getenv("NIM_API_KEY_4", "")
    nim_base_url: str = os.getenv("NIM_BASE_URL", "https://integrate.api.nvidia.com")
    nim_model_neotron: str = _str_env("NIM_MODEL_NEOTRON", "mistralai/mistral-nemotron")
    nim_model_qwen_docs: str = _str_env("NIM_MODEL_QWEN_DOCS", "google/gemma-4-31b-it")
    nim_model_qwen_review: str = _str_env("NIM_MODEL_QWEN_REVIEW", "meta/llama-3.1-8b-instruct")
    nim_request_timeout_seconds: int = _int_env("NIM_REQUEST_TIMEOUT_SECONDS", 60, minimum=10)
    nim_max_retries: int = _int_env("NIM_MAX_RETRIES", 3, minimum=1)
    nim_max_tokens: int = _int_env("NIM_MAX_TOKENS", 512, minimum=128)
    nim_rate_limit_rpm: int = _int_env("NIM_RATE_LIMIT_RPM", 180, minimum=1)

    # Per-call-kind budgets. Short JSON findings need far less headroom than prose
    # summaries or README generation, and giving them less keeps latency bounded.
    nim_agent_timeout_seconds: int = _int_env("NIM_AGENT_TIMEOUT_SECONDS", 45, minimum=10)
    nim_docs_timeout_seconds: int = _int_env("NIM_DOCS_TIMEOUT_SECONDS", 90, minimum=15)
    nim_max_tokens_agent: int = _int_env("NIM_MAX_TOKENS_AGENT", 1024, minimum=128)
    nim_max_tokens_summary: int = _int_env("NIM_MAX_TOKENS_SUMMARY", 2048, minimum=256)

    # How many NIM requests may be in flight at once per client. The RPM pacer still applies.
    nim_max_concurrency: int = _int_env("NIM_MAX_CONCURRENCY", 8, minimum=1)

    # Review pipeline behaviour
    review_use_langgraph: bool = _bool_env("REVIEW_USE_LANGGRAPH", True)
    review_max_snippet_chars: int = _int_env("REVIEW_MAX_SNIPPET_CHARS", 1800, minimum=500)
    review_fastpath_max_chars: int = _int_env("REVIEW_FASTPATH_MAX_CHARS", 5000, minimum=500)
    review_max_llm_files: int = _int_env("REVIEW_MAX_LLM_FILES", 8, minimum=1)

    # Hard caps to prevent job status from staying "processing" forever.
    job_phase_timeout_seconds: int = _int_env("JOB_PHASE_TIMEOUT_SECONDS", 300, minimum=60)
    job_stale_timeout_seconds: int = _int_env("JOB_STALE_TIMEOUT_SECONDS", 420, minimum=120)


settings = Settings()
