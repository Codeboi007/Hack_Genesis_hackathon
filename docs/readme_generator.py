from __future__ import annotations

from collections import Counter
from pathlib import PurePosixPath
from typing import Any


PERSONA_HINTS = {
    "Intern": "Use simple language, explain why each step matters, and include learning tips.",
    "Student": "Balance conceptual clarity with practical usage examples.",
    "Frontend Developer": "Highlight UI architecture, component structure, and API integration details.",
    "Backend Developer": "Focus on service boundaries, data flow, performance, and deployment details.",
}


def build_repo_facts(parsed_files: list[dict[str, Any]]) -> dict[str, Any]:
    langs = Counter(item["language"] for item in parsed_files)
    total_functions = sum(len(item["functions"]) for item in parsed_files)
    total_classes = sum(len(item["classes"]) for item in parsed_files)
    return {
        "languages": dict(langs),
        "file_count": len(parsed_files),
        "function_count": total_functions,
        "class_count": total_classes,
    }


def _normalize_repo_path(path: str) -> str:
    clean = path.replace("\\", "/").strip()
    if not clean:
        return ""
    # Strip absolute/system prefixes and keep only repo-relative tail.
    markers = ["/src/", "/workspace/", "/tmp/", "/var/", "/opt/", "/home/"]
    for marker in markers:
        if marker in clean:
            clean = clean.split(marker, 1)[-1]
    return clean.lstrip("/")


def _looks_like_system_path(path: str) -> bool:
    lowered = path.lower()
    return lowered.startswith(("/", "c:/", "d:/", "e:/")) or "/opt/render/" in lowered or "/tmp/" in lowered


def _sanitize_files(parsed_files: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for item in parsed_files:
        path = _normalize_repo_path(str(item.get("path", "")))
        if not path or _looks_like_system_path(path):
            continue
        clean = dict(item)
        clean["path"] = path
        out.append(clean)
    return out


def _module_role(item: dict[str, Any]) -> str:
    path = item["path"].lower()
    imports = " ".join(item.get("imports", [])).lower()
    fn_count = len(item.get("functions", []))
    cls_count = len(item.get("classes", []))

    if any(key in path for key in ("main", "app.py", "server", "index.ts", "index.js")):
        return "Likely entrypoint or application bootstrap."
    if any(key in path for key in ("route", "controller", "api")):
        return "API routing or request/response boundary."
    if any(key in path for key in ("component", ".tsx", ".jsx", "ui/")):
        return "UI/component layer."
    if "fastapi" in imports or "flask" in imports:
        return "Backend service layer."
    if cls_count > fn_count:
        return "Class-oriented domain logic."
    if fn_count > 0:
        return "Function-oriented utility/business logic."
    return "Support/configuration module."


def _module_map(parsed_files: list[dict[str, Any]], max_items: int = 10) -> str:
    ranked = sorted(parsed_files, key=lambda x: (x.get("line_count", 0), len(x.get("functions", []))), reverse=True)
    lines: list[str] = []
    for item in ranked[:max_items]:
        imports = ", ".join(item.get("imports", [])[:4]) or "none"
        lines.append(
            f"- `{item['path']}` ({item.get('line_count', 0)} lines) "
            f"-> {len(item.get('functions', []))} functions, {len(item.get('classes', []))} classes. "
            f"Role: {_module_role(item)} Imports: {imports}."
        )
    return "\n".join(lines) or "- No modules detected."


def _structure_tree(parsed_files: list[dict[str, Any]], max_lines: int = 36) -> str:
    paths = sorted({_normalize_repo_path(item["path"]) for item in parsed_files if item.get("path")})
    if not paths:
        return "```text\n(no files parsed)\n```"

    tree: dict[str, Any] = {}
    for path in paths:
        cursor = tree
        parts = [p for p in PurePosixPath(path).parts if p]
        for part in parts:
            cursor = cursor.setdefault(part, {})

    lines: list[str] = []

    def walk(node: dict[str, Any], prefix: str = "") -> None:
        keys = sorted(node.keys())
        for i, name in enumerate(keys):
            branch = "└── " if i == len(keys) - 1 else "├── "
            lines.append(f"{prefix}{branch}{name}")
            next_prefix = f"{prefix}{'    ' if i == len(keys) - 1 else '│   '}"
            walk(node[name], next_prefix)

    walk(tree)
    if len(lines) > max_lines:
        lines = lines[:max_lines] + ["..."]
    return "```text\n" + "\n".join(lines) + "\n```"


def _entrypoint_candidates(parsed_files: list[dict[str, Any]], max_items: int = 6) -> str:
    candidates = []
    for item in parsed_files:
        path = item["path"].lower()
        if any(name in path for name in ("main.py", "app.py", "server.py", "index.ts", "index.js")):
            candidates.append(item["path"])
    if not candidates:
        candidates = [item["path"] for item in parsed_files[:max_items]]
    return "\n".join(f"- `{path}`" for path in candidates[:max_items])


def _entrypoint_paths(parsed_files: list[dict[str, Any]], max_items: int = 6) -> list[str]:
    candidates: list[str] = []
    for item in parsed_files:
        path = item["path"].lower()
        if any(name in path for name in ("main.py", "app.py", "server.py", "index.ts", "index.js")):
            candidates.append(item["path"])
    return candidates[:max_items]


def _infer_overview(parsed_files: list[dict[str, Any]]) -> str:
    files = [item["path"].lower() for item in parsed_files]
    flags = {
        "api": any(x in p for p in files for x in ("api", "route", "controller", "fastapi")),
        "docs": any(x in p for p in files for x in ("doc", "readme", "parser")),
        "review": any(x in p for p in files for x in ("review", "agent", "orchestrator")),
        "frontend": any(x in p for p in files for x in ("frontend", ".tsx", ".jsx", "next")),
        "rag": any("rag" in p for p in files),
        "github": any("github" in p or "webhook" in p for p in files),
    }
    parts = []
    if flags["api"]:
        parts.append("provides a backend API for repository analysis workflows")
    if flags["review"]:
        parts.append("runs automated multi-agent code review passes")
    if flags["docs"]:
        parts.append("generates repository documentation from parsed source")
    if flags["rag"]:
        parts.append("uses retrieval indexing to ground analysis prompts")
    if flags["github"]:
        parts.append("integrates with GitHub webhooks and PR automation")
    if flags["frontend"]:
        parts.append("includes a dashboard UI for review and docs runs")
    if not parts:
        return "Codebase centers on parsing repository modules and generating developer-facing outputs from detected structure."
    sentence = "; ".join(parts[:4])
    return sentence[0].upper() + sentence[1:] + "."


def _group_paths(parsed_files: list[dict[str, Any]]) -> dict[str, list[str]]:
    groups: dict[str, list[str]] = {
        "ingestion": [],
        "reasoning": [],
        "retrieval": [],
        "api": [],
        "frontend": [],
        "integration": [],
        "docs": [],
        "other": [],
    }
    for item in parsed_files:
        path = item["path"]
        lower = path.lower()
        if any(k in lower for k in ("ingest", "loader", "parser")):
            groups["ingestion"].append(path)
        elif any(k in lower for k in ("review", "agent", "orchestrator", "nim_client", "structure")):
            groups["reasoning"].append(path)
        elif "rag" in lower:
            groups["retrieval"].append(path)
        elif any(k in lower for k in ("backend/main.py", "/api", "routes", "controller")):
            groups["api"].append(path)
        elif lower.startswith("frontend/") or any(k in lower for k in (".tsx", ".jsx")):
            groups["frontend"].append(path)
        elif "github" in lower or "webhook" in lower:
            groups["integration"].append(path)
        elif "doc" in lower or lower.endswith(".md"):
            groups["docs"].append(path)
        else:
            groups["other"].append(path)
    return groups


def _module_explanations(parsed_files: list[dict[str, Any]], max_items: int = 12) -> str:
    ranked = sorted(
        parsed_files,
        key=lambda x: (len(x.get("imports", [])) + len(x.get("functions", [])) + len(x.get("classes", [])), x.get("line_count", 0)),
        reverse=True,
    )
    lines: list[str] = []
    for item in ranked[:max_items]:
        path = item["path"]
        imports = ", ".join(item.get("imports", [])[:4]) or "none"
        fns = [f.get("name", "") for f in item.get("functions", [])[:3] if f.get("name")]
        classes = [c.get("name", "") for c in item.get("classes", [])[:2] if c.get("name")]
        symbols = ", ".join([*(f"`{c}`" for c in classes), *(f"`{f}()`" for f in fns)]) or "no detected symbols"
        lines.append(f"- **`{path}`**: symbols {symbols}; imports {imports}.")
    return "\n".join(lines) or "- No module relationships detected."


def _usage_section(parsed_files: list[dict[str, Any]]) -> str:
    paths = {item["path"].replace("\\", "/") for item in parsed_files}
    has_backend = any(p.startswith("backend/") for p in paths)
    has_frontend = any(p.startswith("frontend/") for p in paths)
    has_frontend_package = "frontend/package.json" in paths
    has_backend_main = "backend/main.py" in paths

    commands: list[str] = []
    if has_backend_main:
        commands.extend(
            [
                "python -m venv .venv",
                "source .venv/bin/activate",
                "pip install -r backend/requirements.txt",
                "uvicorn backend.main:app --host 0.0.0.0 --port 8000",
            ]
        )
    if has_frontend and has_frontend_package:
        if commands:
            commands.append("")
        commands.extend(["cd frontend", "npm install", "npm run dev"])

    if not commands:
        entries = _entrypoint_paths(parsed_files)
        if not entries:
            return ""
        entry = entries[0]
        run_cmd = ""
        if entry.endswith(".py"):
            run_cmd = f"python {entry}"
        elif entry.endswith(".ts"):
            run_cmd = f"npx ts-node {entry}"
        elif entry.endswith(".js"):
            run_cmd = f"node {entry}"
        return f"```bash\n{run_cmd}\n```" if run_cmd else ""

    return "```bash\n" + "\n".join(commands) + "\n```"


def _project_type(parsed_files: list[dict[str, Any]]) -> str:
    paths = [item["path"].replace("\\", "/").lower() for item in parsed_files]
    has_frontend = any(p.startswith("frontend/") or p.endswith((".tsx", ".jsx")) for p in paths)
    has_backend = any(p.startswith("backend/") for p in paths)
    has_api = any("fastapi" in " ".join(item.get("imports", [])).lower() for item in parsed_files)
    has_agents = any(p.startswith("agents/") for p in paths)
    has_rag = any(p.startswith("rag/") for p in paths)

    if has_frontend and has_backend:
        if has_api and (has_agents or has_rag):
            return "Full-stack web application with an API service and AI-assisted analysis pipeline."
        return "Full-stack web application."
    if has_api:
        return "API service."
    if has_agents or has_rag:
        return "AI/ML-assisted backend system."
    return "Unknown"


def _architecture_flow(parsed_files: list[dict[str, Any]]) -> str:
    paths = {item["path"].replace("\\", "/") for item in parsed_files}
    lines: list[str] = []
    if "backend/main.py" in paths:
        lines.append("- API requests are handled by `backend/main.py` and dispatched to async background jobs.")
    if any(p.startswith("backend/services/ingestion") for p in paths):
        lines.append("- Repository input (URL/ZIP) is normalized into a workspace by `backend/services/ingestion.py`.")
    if any(p.startswith("docs/parser.py") for p in paths) or "docs/parser.py" in paths:
        lines.append("- Source files are discovered and parsed using `docs/repo_loader.py` and `docs/parser.py`.")
    if any(p.startswith("rag/") for p in paths):
        lines.append("- Parsed content is indexed in `rag/rag_pipeline.py` for retrieval-assisted review/docs generation.")
    if any(p.startswith("agents/") for p in paths):
        lines.append("- Review findings are produced by multi-agent analysis from `agents/` and orchestrated by `agents/orchestrator.py`.")
    if "backend/services/doc_service.py" in paths:
        lines.append("- Documentation output is assembled in `backend/services/doc_service.py` and includes README, modular docs, and graphs.")
    if "frontend/lib/api.ts" in paths:
        lines.append("- Frontend polling in `frontend/lib/api.ts` reads job progress via `GET /api/jobs/{job_id}`.")
    return "\n".join(lines)


def _project_structure_block(parsed_files: list[dict[str, Any]], max_per_group: int = 6) -> str:
    groups: dict[str, list[str]] = {}
    for item in parsed_files:
        path = item["path"].replace("\\", "/")
        top = path.split("/", 1)[0] if "/" in path else "root"
        groups.setdefault(top, [])
        groups[top].append(path)

    lines = ["```text"]
    for top in sorted(groups):
        lines.append(f"{top}/")
        for path in sorted(groups[top])[:max_per_group]:
            if "/" in path:
                lines.append(f"  - {path}")
        if len(groups[top]) > max_per_group:
            lines.append("  - ...")
    lines.append("```")
    return "\n".join(lines)


def _architecture_section(parsed_files: list[dict[str, Any]]) -> str:
    groups = _group_paths(parsed_files)
    lines: list[str] = []
    for name in ("api", "ingestion", "reasoning", "retrieval", "integration", "frontend", "docs"):
        items = groups.get(name, [])
        if not items:
            continue
        sample = ", ".join(f"`{p}`" for p in items[:3])
        lines.append(f"- **{name}**: {sample}")
    return "\n".join(lines) or "- No architectural relationships detected."


def _change_map(parsed_files: list[dict[str, Any]]) -> str:
    hints = []
    for item in parsed_files[:24]:
        path = item["path"].lower()
        original = item["path"]
        if any(k in path for k in ("readme", "docs", "guide")):
            hints.append(f"- Documentation updates: `{original}`")
        elif any(k in path for k in ("api", "route", "controller")):
            hints.append(f"- API behavior changes: `{original}`")
        elif any(k in path for k in ("component", ".tsx", ".jsx", "ui/")):
            hints.append(f"- UI/UX updates: `{original}`")
        elif any(k in path for k in ("agent", "service", "logic", "core")):
            hints.append(f"- Core logic changes: `{original}`")
    deduped = []
    seen = set()
    for line in hints:
        if line in seen:
            continue
        seen.add(line)
        deduped.append(line)
    return "\n".join(deduped[:12]) or "- Core changes: inspect entrypoint and largest modules."


def _tech_stack(parsed_files: list[dict[str, Any]]) -> str:
    """Infer tech stack from actual imports across all files."""
    all_imports: list[str] = []
    for item in parsed_files:
        all_imports.extend(item.get("imports", []))

    known = {
        "fastapi": "FastAPI", "flask": "Flask", "django": "Django",
        "next": "Next.js", "react": "React", "vue": "Vue",
        "sqlalchemy": "SQLAlchemy", "prisma": "Prisma",
        "pydantic": "Pydantic", "pytest": "pytest",
        "openai": "OpenAI SDK", "anthropic": "Anthropic SDK",
        "httpx": "httpx", "requests": "requests",
        "uvicorn": "Uvicorn", "gunicorn": "Gunicorn",
        "redis": "Redis", "celery": "Celery",
        "numpy": "NumPy", "pandas": "Pandas", "torch": "PyTorch",
        "langchain": "LangChain", "jwt": "PyJWT",
        "tailwind": "TailwindCSS", "typescript": "TypeScript",
    }
    detected = []
    seen = set()
    for imp in all_imports:
        imp_lower = imp.lower().split(".")[0]
        for key, label in known.items():
            if key in imp_lower and label not in seen:
                detected.append(f"- **{label}**")
                seen.add(label)
    return "\n".join(detected) or "- (detected from imports)"


def _key_symbols(parsed_files: list[dict[str, Any]], max_files: int = 8) -> str:
    """List real function/class names from the most important files."""
    ranked = sorted(
        parsed_files,
        key=lambda x: (len(x.get("functions", [])) + len(x.get("classes", [])), x.get("line_count", 0)),
        reverse=True,
    )
    lines: list[str] = []
    for item in ranked[:max_files]:
        fns = [f"`{f['name']}()`" for f in item.get("functions", [])[:5]]
        classes = [f"`{c['name']}`" for c in item.get("classes", [])[:3]]
        symbols = ", ".join(classes + fns) or "no exported symbols"
        lines.append(f"- **`{item['path']}`** — {symbols}")
    return "\n".join(lines) or "- No symbols detected."


def _code_snippet(parsed_files: list[dict[str, Any]]) -> str:
    """Pull a short real code snippet from the primary entrypoint."""
    for item in parsed_files:
        path = item["path"].lower()
        if any(name in path for name in ("main.py", "app.py", "server.py", "index.ts", "index.js")):
            content = item.get("content", "")
            if content:
                lines = content.strip().splitlines()[:20]
                return "```" + item.get("language", "") + "\n" + "\n".join(lines) + "\n```"
    return ""


def create_readme_template(parsed_files: list[dict[str, Any]], persona: str, repo_name: str = "") -> str:
    parsed_files = _sanitize_files(parsed_files)
    facts = build_repo_facts(parsed_files)
    lang_block = "\n".join(f"- **{k}**: {v} file(s)" for k, v in facts["languages"].items()) or "- No language data."

    # Use provided repo name or infer from file paths
    if not repo_name:
        repo_name = "Repository"

    usage = _usage_section(parsed_files)
    usage_block = f"\n## Usage\n{usage}\n" if usage else ""
    architecture = _architecture_flow(parsed_files) or _architecture_section(parsed_files)

    return f"""# {repo_name}

## Overview
{_infer_overview(parsed_files)}

Project type: {_project_type(parsed_files)}

Parsed surface: **{facts['file_count']} files** · **{facts['function_count']} functions** · **{facts['class_count']} classes**

## Architecture / How It Works
{architecture}

## Project Structure
{_project_structure_block(parsed_files)}

## Key Components
{_module_explanations(parsed_files)}

## Technologies Used
{lang_block}
{_tech_stack(parsed_files)}
{usage_block}
"""


def create_onboarding_guide(parsed_files: list[dict[str, Any]], persona: str) -> str:
    first_files = "\n".join(
        f"- `{item['path']}` -> {_module_role(item)}" for item in sorted(parsed_files, key=lambda x: x.get("line_count", 0), reverse=True)[:8]
    )
    change_map = _change_map(parsed_files)
    return f"""# Onboarding Guide ({persona})

## First 30 Minutes
{first_files or '- Explore repository root files'}

## What to Learn First
- Understand entrypoints and request flow.
- Identify core modules and utility layers.
- Run the project locally and verify health endpoints.

## Where To Change What
{change_map}

## Contribution Checklist
- Add tests for behavior changes.
- Keep docs in sync with code.
- Run static checks before opening a PR.
"""
