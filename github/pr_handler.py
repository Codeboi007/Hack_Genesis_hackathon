from __future__ import annotations

from typing import Any

from docs.parser import parse_file
from github.diff_fetcher import fetch_pr_diff, parse_unified_diff


def build_virtual_files_from_diff(diff_text: str) -> list[dict[str, Any]]:
    sections = parse_unified_diff(diff_text)
    parsed: list[dict[str, Any]] = []
    for section in sections:
        content_lines = [
            line[1:] for line in section["patch"].splitlines() if line.startswith("+") and not line.startswith("+++")
        ]
        content = "\n".join(content_lines)
        parsed.append(
            {
                "path": section["file"],
                "language": section["file"].split(".")[-1],
                "imports": [],
                "functions": [],
                "classes": [],
                "line_count": len(content_lines),
                "content": content,
            }
        )
    return parsed
