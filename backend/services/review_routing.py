from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from backend.services.review_prompts import AGENT_PROMPTS, AgentPrompt
from backend.utils.settings import settings

logger = logging.getLogger(__name__)

# Extension buckets used for classification.
STYLE_EXTENSIONS = {"css", "scss", "sass", "less", "html", "htm", "svg"}
DOC_EXTENSIONS = {"md", "mdx", "rst", "txt", "adoc"}
CONFIG_EXTENSIONS = {"json", "yaml", "yml", "toml", "ini", "cfg", "lock"}
UI_EXTENSIONS = {"tsx", "jsx", "vue", "svelte", "html"}

# Any of these in file content forces the Security agent on, regardless of routing.
SECURITY_KEYWORDS = (
    "auth", "login", "password", "passwd", "secret", "token", "credential",
    "jwt", "oauth", "session", "cookie", "crypt", "cipher", "hash", "hmac",
    "sql", "select ", "insert into", "update ", "delete from", "execute(",
    "subprocess", "os.system", "eval(", "exec(", "pickle", "deserialize",
)

# Agents that only make sense when real program logic is present.
LOGIC_AGENTS = {"Bug & Safety", "Security", "Architecture"}


@dataclass
class RepoProfile:
    """Cheap, deterministic classification of what we are about to review."""

    file_count: int = 0
    total_chars: int = 0
    total_lines: int = 0
    extensions: dict[str, int] = field(default_factory=dict)
    style_only: bool = False
    docs_only: bool = False
    has_ui_files: bool = False
    has_security_signals: bool = False

    def describe(self) -> str:
        top = sorted(self.extensions.items(), key=lambda kv: -kv[1])[:4]
        ext_str = ", ".join(f"{ext}:{count}" for ext, count in top) or "none"
        flags = []
        if self.style_only:
            flags.append("style-only")
        if self.docs_only:
            flags.append("docs-only")
        if self.has_ui_files:
            flags.append("ui")
        if self.has_security_signals:
            flags.append("security-signals")
        return f"files={self.file_count} lines={self.total_lines} ext=[{ext_str}] flags=[{', '.join(flags) or 'none'}]"


def _ext_of(item: dict[str, Any]) -> str:
    lang = str(item.get("language", "")).lower().lstrip(".")
    if lang:
        return lang
    path = str(item.get("path", ""))
    return path.rsplit(".", 1)[-1].lower() if "." in path else ""


def classify(parsed_files: list[dict[str, Any]]) -> RepoProfile:
    profile = RepoProfile(file_count=len(parsed_files))
    if not parsed_files:
        profile.docs_only = True
        return profile

    non_config_exts: set[str] = set()
    for item in parsed_files:
        ext = _ext_of(item)
        profile.extensions[ext] = profile.extensions.get(ext, 0) + 1
        content = str(item.get("content", ""))
        profile.total_chars += len(content)
        profile.total_lines += int(item.get("line_count", 0) or len(content.splitlines()))

        if ext in UI_EXTENSIONS:
            profile.has_ui_files = True
        if ext not in CONFIG_EXTENSIONS:
            non_config_exts.add(ext)
        if not profile.has_security_signals:
            lowered = content.lower()
            if any(keyword in lowered for keyword in SECURITY_KEYWORDS):
                profile.has_security_signals = True

    # Config files alone tell us nothing about intent, so classify on the rest.
    considered = non_config_exts or set(profile.extensions)
    profile.style_only = bool(considered) and considered.issubset(STYLE_EXTENSIONS)
    profile.docs_only = bool(considered) and considered.issubset(DOC_EXTENSIONS)
    return profile


def complexity_score(item: dict[str, Any]) -> float:
    """
    Rank files by how much reviewable substance they contain.

    Line count alone over-weights generated or data-heavy files, so symbol density
    and fan-out carry most of the weight.
    """
    lines = int(item.get("line_count", 0) or 0)
    functions = len(item.get("functions", []) or [])
    classes = len(item.get("classes", []) or [])
    imports = len(item.get("imports", []) or [])
    ext = _ext_of(item)

    score = (functions * 3.0) + (classes * 4.0) + (imports * 1.5) + (lines * 0.05)
    if ext in DOC_EXTENSIONS or ext in CONFIG_EXTENSIONS:
        score *= 0.2
    return score


def rank_by_complexity(parsed_files: list[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    return sorted(parsed_files, key=complexity_score, reverse=True)[:limit]


def should_use_fast_path(profile: RepoProfile) -> bool:
    """
    A single compact call beats a six-agent fan-out when there is barely anything to read.

    Mirrors the brief: tiny content, a single file, or a trivially small change.
    """
    if profile.docs_only:
        return False  # handled earlier by select_agents returning nothing
    if profile.file_count <= 1:
        return True
    if profile.total_chars < settings.review_fastpath_max_chars:
        return True
    if profile.total_lines < 50:
        return True
    return False


def select_agents(profile: RepoProfile) -> list[AgentPrompt]:
    """Decide which LLM agents are worth spending a round-trip on."""
    if profile.docs_only:
        logger.info("Agent routing | docs-only change, skipping all LLM agents")
        return []

    selected: list[AgentPrompt] = []
    for agent in AGENT_PROMPTS:
        # Style/markup-only changes have no logic for these agents to reason about.
        if profile.style_only and agent.name in LOGIC_AGENTS:
            continue
        # Accessibility has nothing to say without markup.
        if agent.name == "Accessibility" and not profile.has_ui_files and not profile.style_only:
            continue
        selected.append(agent)

    # Security is never skipped when the code touches auth, crypto, or SQL.
    if profile.has_security_signals and not any(a.name == "Security" for a in selected):
        from backend.services.review_prompts import AGENT_PROMPTS_BY_NAME

        selected.append(AGENT_PROMPTS_BY_NAME["Security"])
        logger.info("Agent routing | security signals detected, forcing Security agent on")

    logger.info(
        "Agent routing | %s -> agents=[%s]",
        profile.describe(),
        ", ".join(a.name for a in selected) or "none",
    )
    return selected


def select_files_for_agent(
    agent: AgentPrompt,
    parsed_files: list[dict[str, Any]],
    limit: int | None = None,
) -> list[dict[str, Any]]:
    """
    Narrow the file set to what this specific agent can actually act on.

    Previously every agent received the same ~56 KB payload regardless of focus, so the
    Accessibility agent read Python services and the Security agent read CSS.
    """
    limit = limit or settings.review_max_llm_files

    # Prose and lockfiles are not reviewable source. Excluded up front so a weak
    # content-marker match can never fall back to handing an agent a pile of markdown.
    non_source = DOC_EXTENSIONS | CONFIG_EXTENSIONS
    wanted = set(agent.extensions)
    candidates = [
        item for item in parsed_files
        if _ext_of(item) not in non_source or _ext_of(item) in wanted
    ]
    if not candidates:
        return []

    if agent.extensions:
        allowed = set(agent.extensions)
        filtered = [item for item in candidates if _ext_of(item) in allowed]
        # A hard extension filter is authoritative: no matching files means no work.
        candidates = filtered
        if not candidates:
            return []

    if agent.content_markers:
        markers = agent.content_markers
        marked = [
            item
            for item in candidates
            if any(marker in str(item.get("content", "")) for marker in markers)
        ]
        # Content markers are a heuristic, so fall back to the unfiltered set.
        candidates = marked or candidates

    if agent.name == "Architecture":
        # Architecture only has signal where a file actually depends on others.
        rich = [item for item in candidates if len(item.get("imports", []) or []) > 3]
        candidates = rich or candidates

    return rank_by_complexity(candidates, limit)
