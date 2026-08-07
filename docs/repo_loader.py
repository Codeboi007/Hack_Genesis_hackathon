from __future__ import annotations

import logging
from pathlib import Path

logger = logging.getLogger(__name__)

TEXT_EXTENSIONS = {
    ".py",
    ".js",
    ".ts",
    ".tsx",
    ".jsx",
    ".java",
    ".go",
    ".rs",
    ".v",
    ".sv",
    ".vh",
    ".svh",
    ".md",
    ".json",
    ".yaml",
    ".yml",
    ".toml",
}

IGNORED_DIRS = {
    ".git",
    "node_modules",
    ".next",
    "dist",
    "build",
    "venv",
    ".venv",
    "__pycache__",
    ".mypy_cache",
    ".pytest_cache",
    "coverage",
    ".tox",
}


def iter_code_files(root: Path, max_files: int = 300, max_file_size: int = 300_000) -> list[Path]:
    files: list[Path] = []
    for path in root.rglob("*"):
        if len(files) >= max_files:
            break
        # Skip hidden dirs and ignored dirs anywhere in path
        if any(part in IGNORED_DIRS or part.startswith(".") and part not in (".env",)
               for part in path.parts if part != path.parts[0]):
            if path.is_dir():
                continue
            # File inside ignored dir
            if any(p in IGNORED_DIRS for p in path.parts):
                continue
        if not path.is_file():
            continue
        if path.suffix.lower() not in TEXT_EXTENSIONS:
            continue
        if any(p in IGNORED_DIRS for p in path.parts):
            continue
        try:
            size = path.stat().st_size
        except OSError:
            logger.debug("Skipping unreadable path: %s", path)
            continue
        if size > max_file_size:
            continue
        files.append(path)
    return files


def read_text_safe(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return path.read_text(encoding="latin-1", errors="ignore")
