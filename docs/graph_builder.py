from __future__ import annotations

from typing import Any


def build_dependency_graph(parsed_files: list[dict[str, Any]]) -> dict[str, Any]:
    nodes = _build_module_nodes(parsed_files)
    edges = _build_import_edges(parsed_files)
    return _finalize_graph(nodes, edges)


def build_execution_flowchart(parsed_files: list[dict[str, Any]]) -> dict[str, Any]:
    nodes = _build_module_nodes(parsed_files)
    # Keep flowchart module-level for readability; avoid per-function clutter.
    edges = _build_import_edges(parsed_files)
    return _finalize_graph(nodes, edges)


def build_knowledge_graph(parsed_files: list[dict[str, Any]]) -> dict[str, Any]:
    nodes = _build_module_nodes(parsed_files)
    edges = _build_import_edges(parsed_files)
    return _finalize_graph(nodes, edges)


def _build_module_nodes(parsed_files: list[dict[str, Any]]) -> list[dict[str, Any]]:
    nodes: list[dict[str, Any]] = []
    for item in parsed_files:
        path = _norm_path(item.get("path", ""))
        if not path:
            continue
        group = path.split("/", 1)[0] if "/" in path else "root"
        label = path.split("/")[-1]
        nodes.append({"id": path, "label": label, "kind": f"group:{group}"})
    return nodes


SOURCE_SUFFIXES = (
    ".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
    ".go", ".rs", ".java", ".v", ".sv", ".vh", ".svh",
)

# Package entrypoints an import of a *directory* should resolve to.
INDEX_FILES = ("__init__.py", "index.ts", "index.tsx", "index.js", "index.jsx")


def _build_import_edges(parsed_files: list[dict[str, Any]]) -> list[dict[str, Any]]:
    module_paths = {_norm_path(item.get("path", "")) for item in parsed_files}
    module_paths.discard("")
    edges: list[dict[str, Any]] = []
    for item in parsed_files:
        src = _norm_path(item.get("path", ""))
        if not src:
            continue
        for imp in item.get("imports", []):
            target = _resolve_import_to_module(str(imp), module_paths, src)
            if target and target != src:
                edges.append({"source": src, "target": target, "label": "imports"})
    return edges


def _join_relative(base_dir: str, relative: str) -> str:
    """posixpath.normpath over '/'-joined segments, without touching the filesystem."""
    parts: list[str] = [p for p in base_dir.split("/") if p] if base_dir else []
    for segment in relative.split("/"):
        if segment in ("", "."):
            continue
        if segment == "..":
            if parts:
                parts.pop()
        else:
            parts.append(segment)
    return "/".join(parts)


def _match_module(stem: str, module_paths: set[str]) -> str | None:
    """Resolve a repo-relative module stem to a concrete file, including package indexes."""
    if not stem:
        return None
    for suffix in SOURCE_SUFFIXES:
        candidate = f"{stem}{suffix}"
        if candidate in module_paths:
            return candidate
    for index in INDEX_FILES:
        candidate = f"{stem}/{index}"
        if candidate in module_paths:
            return candidate
    return None


def _match_suffix(stem: str, module_paths: set[str]) -> str | None:
    """
    Match a module stem against the *tail* of known paths.

    Needed because an import reads `requests.models` while the file lives at
    `src/requests/models.py` — the package root is not the repo root.
    """
    if not stem:
        return None
    candidates: list[str] = []
    for suffix in SOURCE_SUFFIXES:
        tail = f"/{stem}{suffix}"
        candidates.extend(p for p in module_paths if p.endswith(tail))
    if not candidates:
        for index in INDEX_FILES:
            tail = f"/{stem}/{index}"
            candidates.extend(p for p in module_paths if p.endswith(tail))
    if not candidates:
        return None
    # Shortest path wins, then alphabetical — keeps the result deterministic.
    return sorted(candidates, key=lambda p: (len(p), p))[0]


def _resolve_import_to_module(
    imp: str,
    module_paths: set[str],
    src_path: str = "",
) -> str | None:
    """
    Map one import statement to a file in this repository, or None if it is external.

    Resolution is source-relative because the dominant real-world forms — Python's
    `from .models import X` and JS's `import x from "./api"` — carry no absolute path
    and are meaningless without knowing which file the import appeared in.
    """
    if not imp:
        return None

    raw = imp.strip().replace("\\", "/")
    if not raw:
        return None

    src_dir = src_path.rsplit("/", 1)[0] if "/" in src_path else ""

    # ── JS/TS relative: "./api", "../lib/api" ────────────────────────────────
    if raw.startswith("./") or raw.startswith("../"):
        return _match_module(_join_relative(src_dir, raw), module_paths)

    # ── Python relative: ".models", "..sessions", "...pkg.mod" ───────────────
    if raw.startswith("."):
        dots = len(raw) - len(raw.lstrip("."))
        remainder = raw[dots:].replace(".", "/")
        # One dot = current package; each extra dot climbs one level.
        base = src_dir
        for _ in range(dots - 1):
            base = base.rsplit("/", 1)[0] if "/" in base else ""
        stem = f"{base}/{remainder}" if base and remainder else (base or remainder)
        return _match_module(stem, module_paths)

    # ── Aliased roots: "@/lib/api", "~/utils" ────────────────────────────────
    if raw.startswith("@/") or raw.startswith("~/"):
        stem = raw[2:]
        return _match_module(stem, module_paths) or _match_suffix(stem, module_paths)

    # ── Absolute / dotted / bare ─────────────────────────────────────────────
    stem = raw.replace(".", "/")
    resolved = _match_module(stem, module_paths)
    if resolved:
        return resolved

    resolved = _match_suffix(stem, module_paths)
    if resolved:
        return resolved

    # Last resort: match on the final segment only ("requests.models" -> models.py).
    # Restricted to multi-segment imports so bare third-party names like "os" or
    # "react" do not latch onto an unrelated local file with the same name.
    if "/" in stem:
        return _match_suffix(stem.rsplit("/", 1)[-1], module_paths)
    return None


def _finalize_graph(nodes: list[dict[str, Any]], edges: list[dict[str, Any]], max_nodes: int = 70, max_edges: int = 140) -> dict[str, Any]:
    unique_nodes = _dedupe_nodes(nodes)
    if not unique_nodes:
        return {"nodes": [], "edges": []}
    node_ids = {n["id"] for n in unique_nodes}
    unique_edges = _dedupe_edges(edges, node_ids)
    trimmed_nodes = unique_nodes[:max_nodes]
    trimmed_ids = {n["id"] for n in trimmed_nodes}
    trimmed_edges = [e for e in unique_edges if e["source"] in trimmed_ids and e["target"] in trimmed_ids][:max_edges]
    return {"nodes": trimmed_nodes, "edges": trimmed_edges}


def _dedupe_nodes(nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for n in nodes:
        node_id = str(n.get("id", "")).strip()
        if not node_id or node_id in seen:
            continue
        seen.add(node_id)
        out.append(n)
    return out


def _dedupe_edges(edges: list[dict[str, Any]], node_ids: set[str]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str]] = set()
    for e in edges:
        src = str(e.get("source", "")).strip()
        tgt = str(e.get("target", "")).strip()
        label = str(e.get("label", "")).strip()
        if not src or not tgt or src not in node_ids or tgt not in node_ids:
            continue
        key = (src, tgt, label)
        if key in seen:
            continue
        seen.add(key)
        out.append({"source": src, "target": tgt, "label": label})
    return out


def _norm_path(path: str) -> str:
    return path.strip().replace("\\", "/")
