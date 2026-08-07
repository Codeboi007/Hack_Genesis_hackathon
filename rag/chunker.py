from __future__ import annotations

from typing import Any


def chunk_parsed_files(parsed_files: list[dict[str, Any]], chunk_size: int = 1200) -> list[dict[str, Any]]:
    chunks: list[dict[str, Any]] = []

    for item in parsed_files:
        content = item.get("content", "")
        path = item["path"]
        lines = content.splitlines()

        start = 0
        while start < len(lines):
            end = min(start + chunk_size // 80 + 1, len(lines))
            text = "\n".join(lines[start:end])
            chunks.append(
                {
                    "id": f"{path}:{start + 1}-{end}",
                    "path": path,
                    "start_line": start + 1,
                    "end_line": end,
                    "text": text,
                }
            )
            start = end

    return chunks
