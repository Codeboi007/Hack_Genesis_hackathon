from __future__ import annotations

from typing import Any


def detect_doc_rot(parsed_files: list[dict[str, Any]], existing_docs: str) -> bool:
    """Detect likely documentation drift by checking module/function coverage."""
    existing = existing_docs.lower()
    misses = 0

    for item in parsed_files[:20]:
        filename = item["path"].split("/")[-1].lower()
        if filename not in existing:
            misses += 1

        for fn in item.get("functions", [])[:5]:
            if fn["name"].lower() not in existing:
                misses += 1

    threshold = max(3, len(parsed_files) // 2)
    return misses >= threshold
