from __future__ import annotations

import json
from typing import Any

from backend.services.nim_client import get_nim_pool
from backend.utils.settings import settings


class StructureService:
    def __init__(self) -> None:
        self.nim = get_nim_pool()

    async def derive(self, parsed_files: list[dict[str, Any]]) -> dict[str, Any]:
        local = self._local_structure(parsed_files)

        sample = [
            {
                "path": item["path"],
                "imports": item.get("imports", [])[:8],
                "functions": [f["name"] for f in item.get("functions", [])[:10]],
                "classes": [c["name"] for c in item.get("classes", [])[:10]],
            }
            for item in parsed_files[:15]
        ]

        prompt = (
            "Analyze this repository structure and return strict JSON with keys: "
            "modules, critical_paths, architectural_risks, dependency_hotspots.\n"
            f"Input: {json.dumps(sample)}"
        )
        out = await self.nim.chat(
            model=settings.nim_model_neotron,
            system_prompt="You are a code structure analyst. Return JSON only.",
            user_prompt=prompt,
            temperature=0.1,
            call_kind="structure",
        )

        parsed = self._parse_json(out) if out else None
        if parsed:
            return {"source": "neotron", "local": local, "neotron": parsed}
        return {"source": "local", "local": local}

    def _local_structure(self, parsed_files: list[dict[str, Any]]) -> dict[str, Any]:
        return {
            "module_count": len(parsed_files),
            "total_functions": sum(len(item.get("functions", [])) for item in parsed_files),
            "total_classes": sum(len(item.get("classes", [])) for item in parsed_files),
            "top_imports": sorted(
                {
                    imp
                    for item in parsed_files
                    for imp in item.get("imports", [])
                }
            )[:25],
        }

    def _parse_json(self, text: str) -> dict[str, Any] | None:
        if not text:
            return None
        cleaned = text.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.strip("`")
            if cleaned.startswith("json"):
                cleaned = cleaned[4:].strip()
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start == -1 or end == -1 or end <= start:
            return None
        try:
            return json.loads(cleaned[start : end + 1])
        except json.JSONDecodeError:
            return None
