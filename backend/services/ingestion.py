from __future__ import annotations

import io
import logging
import shutil
import uuid
import zipfile
from pathlib import Path
from urllib.parse import urlparse

import requests

logger = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parents[2]
WORKSPACE_ROOT = ROOT / "data" / "workspaces"
WORKSPACE_ROOT.mkdir(parents=True, exist_ok=True)

MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024  # 100 MB hard cap


class IngestionError(Exception):
    pass


def _ensure_clean_dir(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path)
    path.mkdir(parents=True, exist_ok=True)


def create_workspace() -> Path:
    run_id = str(uuid.uuid4())
    target = WORKSPACE_ROOT / run_id
    target.mkdir(parents=True, exist_ok=True)
    return target


def cleanup_workspace(workspace: Path) -> None:
    shutil.rmtree(workspace, ignore_errors=True)


def ingest_zip_bytes(blob: bytes, workspace: Path) -> Path:
    if len(blob) > MAX_DOWNLOAD_BYTES:
        raise IngestionError(
            f"Archive too large ({len(blob) // (1024*1024)} MB). Maximum is {MAX_DOWNLOAD_BYTES // (1024*1024)} MB."
        )

    _ensure_clean_dir(workspace)
    try:
        with zipfile.ZipFile(io.BytesIO(blob)) as zf:
            # Safety check: reject zip bombs and path-traversal entries
            for name in zf.namelist():
                if ".." in name or name.startswith("/"):
                    raise IngestionError(f"Unsafe path in ZIP archive: {name!r}")
            zf.extractall(workspace)
    except zipfile.BadZipFile as exc:
        raise IngestionError("Uploaded file is not a valid ZIP archive") from exc
    except IngestionError:
        raise
    except Exception as exc:
        raise IngestionError(f"Failed to extract ZIP: {exc}") from exc

    # If there is exactly one top-level directory and no loose files, descend into it
    try:
        children = list(workspace.iterdir())
        inner_dirs = [p for p in children if p.is_dir()]
        inner_files = [p for p in children if p.is_file()]
        if len(inner_dirs) == 1 and not inner_files:
            return inner_dirs[0]
    except Exception:
        pass

    return workspace


def ingest_from_url(repo_url: str, workspace: Path, github_token: str = "") -> Path:
    parsed = urlparse(repo_url)
    if not parsed.scheme:
        raise IngestionError("Repository URL must include a valid scheme (https://)")

    url = repo_url
    headers: dict[str, str] = {}

    if "github.com" in parsed.netloc:
        cleaned = repo_url.rstrip("/")
        if cleaned.endswith(".git"):
            cleaned = cleaned[:-4]
        
        parts = cleaned.split("/")
        try:
            gh_idx = next(i for i, p in enumerate(parts) if "github.com" in p)
            owner = parts[gh_idx + 1]
            repo = parts[gh_idx + 2]
            owner_repo = f"{owner}/{repo}"
            
            # Check if a specific branch is provided (e.g. /tree/branch-name)
            ref = ""
            if len(parts) > gh_idx + 4 and parts[gh_idx + 3] == "tree":
                ref = "/" + "/".join(parts[gh_idx + 4:])
                
        except (StopIteration, IndexError):
            owner_repo = "/".join(cleaned.split("/")[-2:])
            ref = ""

        url = f"https://api.github.com/repos/{owner_repo}/zipball{ref}"
        headers["Accept"] = "application/vnd.github+json"
        if github_token:
            headers["Authorization"] = f"Bearer {github_token}"

    try:
        response = requests.get(
            url,
            headers=headers,
            timeout=60,
            allow_redirects=True,
            stream=True,
        )
    except requests.RequestException as exc:
        raise IngestionError(f"Network error fetching repository: {exc}") from exc

    if response.status_code >= 400:
        raise IngestionError(f"Failed to fetch repository archive (HTTP {response.status_code})")

    # Stream download with size cap
    chunks: list[bytes] = []
    total = 0
    for chunk in response.iter_content(chunk_size=65536):
        total += len(chunk)
        if total > MAX_DOWNLOAD_BYTES:
            raise IngestionError(
                f"Repository archive exceeds {MAX_DOWNLOAD_BYTES // (1024*1024)} MB limit."
            )
        chunks.append(chunk)

    return ingest_zip_bytes(b"".join(chunks), workspace)
