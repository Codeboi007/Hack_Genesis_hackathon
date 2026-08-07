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


def _build_import_edges(parsed_files: list[dict[str, Any]]) -> list[dict[str, Any]]:
    module_paths = {_norm_path(item.get("path", "")) for item in parsed_files}
    module_paths.discard("")
    edges: list[dict[str, Any]] = []
    for item in parsed_files:
        src = _norm_path(item.get("path", ""))
        if not src:
            continue
        for imp in item.get("imports", []):
            target = _resolve_import_to_module(str(imp), module_paths)
            if target and target != src:
                edges.append({"source": src, "target": target, "label": "imports"})
    return edges


def _resolve_import_to_module(imp: str, module_paths: set[str]) -> str | None:
    if not imp:
        return None
    imp_norm = imp.strip().replace("\\", "/")
    for suffix in (".py", ".ts", ".tsx", ".js", ".jsx", ".go", ".rs", ".java", ".v", ".sv", ".vh", ".svh"):
        candidate = f"{imp_norm.replace('.', '/')}{suffix}"
        if candidate in module_paths:
            return candidate
    base = imp_norm.split(".", 1)[0]
    for path in module_paths:
        if path.endswith(f"/{base}.py") or path.endswith(f"/{base}.ts") or path.endswith(f"/{base}.js"):
            return path
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
