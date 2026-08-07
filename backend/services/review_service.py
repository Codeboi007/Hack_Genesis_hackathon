from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from agents.base_agent import AgentFinding, SEVERITY_ORDER
from agents.orchestrator import ReviewOrchestrator
from backend.services.nim_client import get_nim_pool
from backend.services.persona import persona_explanation_suffix, persona_fix_suffix, persona_style
from backend.services.review_prompts import (
    COMMON_CONSTRAINTS,
    FAST_REVIEW_SCHEMA_GUIDE,
    FILE_SUMMARY_GUIDE,
    JSON_SCHEMA_GUIDE,
    AgentPrompt,
)
from backend.services import review_routing
from backend.services.structure_service import StructureService
from backend.utils.settings import settings
from rag.rag_pipeline import RAGPipeline

logger = logging.getLogger(__name__)


async def _empty_summaries() -> dict[str, str]:
    return {}


class ReviewService:
    def __init__(self, rag: RAGPipeline) -> None:
        self.rag = rag
        self.orchestrator = ReviewOrchestrator()
        self.nim = get_nim_pool()    # round-robin pool across all 4 keys
        self.nim_docs = self.nim      # same pool — no separate docs client
        self.structure = StructureService()

    # ── Public entrypoints ────────────────────────────────────────────────────

    async def review(self, parsed_files: list[dict[str, Any]], persona: str) -> dict[str, Any]:
        logger.info("Review pipeline started | files=%d persona=%s", len(parsed_files), persona)
        index_stats = self.rag.index_repository(parsed_files)

        if settings.review_use_langgraph:
            try:
                from backend.services.review_graph import run_review_graph

                result = await run_review_graph(self, parsed_files, persona)
                result["metadata"]["rag"] = index_stats
                logger.info(
                    "Review pipeline completed | engine=langgraph findings=%d persona=%s",
                    len(result["findings"]), persona,
                )
                return result
            except Exception:
                # LangGraph is an orchestration convenience, not a correctness dependency.
                # If it is unavailable or misbehaves, the legacy path still produces a review.
                logger.exception("LangGraph pipeline failed; falling back to direct parallel path")

        result = await self._review_direct(parsed_files, persona)
        result["metadata"]["rag"] = index_stats
        logger.info(
            "Review pipeline completed | engine=direct findings=%d persona=%s",
            len(result["findings"]), persona,
        )
        return result

    async def review_pr_fast(self, parsed_files: list[dict[str, Any]], persona: str) -> dict[str, Any]:
        """
        Fast PR review path:
        - deterministic agents
        - one LLM call that returns both findings + summary
        """
        logger.info("PR fast review started | files=%d persona=%s", len(parsed_files), persona)
        index_stats = self.rag.index_repository(parsed_files)
        structure_context = await self.structure.derive(parsed_files)

        findings = self.orchestrator.run(parsed_files, persona)
        llm_pack = await self.quick_review(parsed_files, persona, structure_context)
        if llm_pack:
            findings.extend(self._coerce_findings(llm_pack.get("findings", []), fallback_agent="Quick Review"))

        findings = self._dedupe_findings(findings)
        findings = self._apply_persona(findings, persona)

        summary = ""
        if llm_pack and isinstance(llm_pack.get("summary"), str):
            summary = llm_pack["summary"].strip()
        if not summary:
            summary = self._fallback_summary(findings)

        logger.info("PR fast review completed | findings=%d persona=%s", len(findings), persona)
        return {
            "findings": [f.__dict__ for f in findings],
            "summary": summary,
            "reviewed_files": [item["path"] for item in parsed_files],
            "metadata": {
                "rag": index_stats,
                "agent_count": len(self.orchestrator.agents),
                "nim_enabled": self.nim.enabled,
                "structure": structure_context,
                "mode": "pr_fast_single_call",
            },
        }

    # ── Direct (non-LangGraph) pipeline ───────────────────────────────────────

    async def _review_direct(self, parsed_files: list[dict[str, Any]], persona: str) -> dict[str, Any]:
        """
        Fallback pipeline with the same routing and parallelism as the graph, minus the
        declarative structure. Kept so the service never hard-depends on LangGraph.
        """
        profile = review_routing.classify(parsed_files)
        rule_findings = self.orchestrator.run(parsed_files, persona)

        # Docs-only changes have nothing for the LLM to say; skip the whole stage.
        summaries_coro = (
            self.generate_file_summaries(parsed_files)
            if not profile.docs_only
            else _empty_summaries()
        )
        llm_stage, file_summaries = await asyncio.gather(
            self._run_llm_stage(parsed_files, persona, profile),
            summaries_coro,
            return_exceptions=True,
        )
        if isinstance(llm_stage, BaseException):
            logger.warning("LLM stage failed: %s", llm_stage)
            llm_stage = ({}, [], "")
        if isinstance(file_summaries, BaseException):
            logger.warning("File summaries failed: %s", file_summaries)
            file_summaries = {}

        structure_context, llm_findings, summary_seed = llm_stage

        findings = self._dedupe_findings(rule_findings + llm_findings)
        findings = self._apply_persona(findings, persona)

        summary = summary_seed or await self.summarize_findings(findings, persona, structure_context)

        return {
            "findings": [f.__dict__ for f in findings],
            "summary": summary,
            "reviewed_files": [item["path"] for item in parsed_files],
            "file_summaries": file_summaries or {},
            "file_symbols": self.collect_file_symbols(parsed_files),
            "metadata": {
                "agent_count": len(self.orchestrator.agents),
                "nim_enabled": self.nim.enabled,
                "structure": structure_context,
                "mode": "direct_parallel",
                "routing": profile.describe(),
            },
        }

    async def _run_llm_stage(
        self,
        parsed_files: list[dict[str, Any]],
        persona: str,
        profile: review_routing.RepoProfile,
    ) -> tuple[dict[str, Any], list[AgentFinding], str]:
        if not self.nim.enabled:
            return await self.structure.derive(parsed_files), [], ""

        selected = review_routing.select_agents(profile)
        if not selected:
            return {}, [], "No reviewable source changes detected."

        structure_task = asyncio.create_task(self.structure.derive(parsed_files))

        if review_routing.should_use_fast_path(profile):
            structure_context = await structure_task
            pack = await self.quick_review(parsed_files, persona, structure_context)
            if not pack:
                return structure_context, [], ""
            findings = self._coerce_findings(pack.get("findings", []), fallback_agent="Quick Review")
            return structure_context, findings, str(pack.get("summary", "")).strip()

        agent_results = await asyncio.gather(
            *(self.run_agent(agent, parsed_files, persona) for agent in selected),
            return_exceptions=True,
        )
        structure_context = await structure_task

        llm_findings: list[AgentFinding] = []
        for agent, outcome in zip(selected, agent_results):
            if isinstance(outcome, BaseException):
                logger.warning("Agent %s failed: %s", agent.name, outcome)
                continue
            llm_findings.extend(outcome)

        return structure_context, llm_findings, ""

    # ── LLM primitives (shared by the direct path and the LangGraph nodes) ─────

    async def run_agent(
        self,
        agent_prompt: AgentPrompt,
        parsed_files: list[dict[str, Any]],
        persona: str,
    ) -> list[AgentFinding]:
        """One agent, one LLM call. Safe to run concurrently with other agents."""
        if not self.nim.enabled:
            return []

        relevant = review_routing.select_files_for_agent(agent_prompt, parsed_files)
        if not relevant:
            logger.info("Agent skipped (no relevant files) | agent=%s", agent_prompt.name)
            return []

        sample = self._build_sample(relevant, agent_prompt.name)
        if not sample:
            return []

        prompt = f"""
Persona: {persona}
Agent: {agent_prompt.name}
Focus: {agent_prompt.focus}

Task instructions:
{agent_prompt.instructions}

Scope boundary:
{agent_prompt.out_of_scope}

{COMMON_CONSTRAINTS}
- Set "agent" to exactly "{agent_prompt.name}".

{JSON_SCHEMA_GUIDE}

Code input:
{json.dumps(sample)}
""".strip()

        out = await self.nim.chat(
            model=settings.nim_model_qwen_review,
            system_prompt="You are an industrial static code review agent. Return JSON array only.",
            user_prompt=prompt,
            temperature=0.0,
            call_kind="agent",
        )
        if not out:
            return []

        findings = self._coerce_findings(self._parse_json_array(out), fallback_agent=agent_prompt.name)
        logger.info("Agent completed | agent=%s files=%d findings=%d", agent_prompt.name, len(sample), len(findings))
        return findings

    async def quick_review(
        self,
        parsed_files: list[dict[str, Any]],
        persona: str,
        structure_context: dict[str, Any],
    ) -> dict[str, Any] | None:
        """Single compact call returning findings + summary together."""
        if not self.nim.enabled:
            return None

        ranked = review_routing.rank_by_complexity(parsed_files, limit=6)
        sample = self._build_sample(ranked, focus_name="Quick Review")
        compact = [{"path": s["path"], "snippet": s["snippet"][:1800]} for s in sample[:6]]
        if not compact:
            return None

        prompt = f"""
Persona: {persona}
{FAST_REVIEW_SCHEMA_GUIDE}

Repository context:
{json.dumps(self._compact_structure(structure_context))}

Code input:
{json.dumps(compact)}
""".strip()

        out = await self.nim.chat(
            model=settings.nim_model_qwen_review,
            system_prompt="You are a senior code reviewer. Return strict JSON object only.",
            user_prompt=prompt,
            temperature=0.0,
            call_kind="agent",
        )
        if not out:
            return None
        return self._parse_json_object(out)

    @staticmethod
    def collect_file_symbols(
        parsed_files: list[dict[str, Any]],
        limit: int = 12,
    ) -> dict[str, list[str]]:
        """Parser-detected symbols per file for the Code Explainer. No LLM involved."""
        symbols: dict[str, list[str]] = {}
        for item in parsed_files:
            names = [f"{fn['name']}()" for fn in (item.get("functions") or [])[:limit]]
            names += [str(cls["name"]) for cls in (item.get("classes") or [])[:limit]]
            if names:
                symbols[item["path"]] = names[:limit]
        return symbols

    async def generate_file_summaries(
        self,
        parsed_files: list[dict[str, Any]],
        limit: int = 5,
    ) -> dict[str, str]:
        """
        Plain-English "what does this file do" blurbs for the Code Explainer UI.

        One batched call for all files, not one call per file, and it is gathered
        alongside the agent pass so it costs no additional wall-clock time.
        """
        if not self.nim.enabled or not parsed_files:
            return {}

        top = review_routing.rank_by_complexity(parsed_files, limit=limit)
        payload = []
        for item in top:
            payload.append(
                {
                    "path": item["path"],
                    "language": item.get("language", ""),
                    "functions": [f["name"] for f in (item.get("functions") or [])[:10]],
                    "classes": [c["name"] for c in (item.get("classes") or [])[:6]],
                    "imports": (item.get("imports") or [])[:10],
                    "snippet": item.get("content", "")[:1200],
                }
            )
        if not payload:
            return {}

        prompt = f"""
{FILE_SUMMARY_GUIDE}

Files:
{json.dumps(payload)}
""".strip()

        out = await self.nim_docs.chat(
            model=settings.nim_model_qwen_docs,
            system_prompt="You explain code to junior developers. Return strict JSON object only.",
            user_prompt=prompt,
            temperature=0.1,
            call_kind="agent",
        )
        if not out:
            return {}

        parsed = self._parse_json_object(out)
        if not parsed:
            return {}

        valid_paths = {item["path"] for item in top}
        summaries = {
            str(path): str(text).strip()
            for path, text in parsed.items()
            if str(path) in valid_paths and isinstance(text, str) and text.strip()
        }
        logger.info("File summaries generated | count=%d", len(summaries))
        return summaries

    async def summarize_findings(
        self,
        findings: list[Any],
        persona: str,
        structure_context: dict[str, Any],
        model: str | None = None,
    ) -> str:
        if not findings:
            return (
                "No high-confidence issues were found in this diff. "
                "The changes look stable — good to proceed once any open threads are resolved."
            )

        top = findings[:8]
        critical_high = [f for f in top if f.severity in {"critical", "high"}]
        medium_low    = [f for f in top if f.severity in {"medium", "low"}]

        def fmt(items: list[Any]) -> str:
            return "\n".join(
                f"- {item.issue_title} ({item.file}:{item.line})"
                for item in items
            )

        sections = []
        if critical_high:
            sections.append(f"Must fix before merge:\n{fmt(critical_high)}")
        if medium_low:
            sections.append(f"Follow-up items:\n{fmt(medium_low)}")

        findings_block = "\n\n".join(sections)

        prompt = f"""
{persona_style(persona)}

Write a code review summary for a pull request. Tone: direct, collegial, professional.
Do NOT use phrases like \"AI\", \"I detected\", or \"analysis found\".
Start with what the diff is changing overall, then address the most important issue,
then give the recommended next action. 4 sentences maximum. No markdown headings.

Findings to summarise:
{findings_block}

Repository context (for framing only):
{json.dumps(self._compact_structure(structure_context))}
""".strip()

        generated = await self.nim.chat(
            model=model or settings.nim_model_qwen_review,
            system_prompt=(
                "You are a staff engineer writing a PR review summary. "
                "Write as a human reviewer, not as a tool. No AI self-references."
            ),
            user_prompt=prompt,
            temperature=0.15,
            call_kind="summary",
        )

        if generated:
            return generated.strip()

        # Graceful fallback if LLM call fails
        return self._fallback_summary(findings)

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _compact_structure(self, structure_context: dict[str, Any]) -> dict[str, Any]:
        """
        Forward only the small deterministic counters into downstream prompts.

        The raw Nemotron blob was previously re-serialised into every summary prompt,
        which inflated tokens without improving the summary.
        """
        if not isinstance(structure_context, dict):
            return {}
        local = structure_context.get("local")
        return local if isinstance(local, dict) else {}

    def _coerce_findings(self, parsed: list[dict[str, Any]], fallback_agent: str) -> list[AgentFinding]:
        findings: list[AgentFinding] = []
        for item in parsed:
            try:
                confidence = float(item.get("confidence", 0))
                if confidence < 0.75:
                    continue
                severity = str(item.get("severity", "medium")).lower()
                if severity not in {"low", "medium", "high", "critical"}:
                    severity = "medium"
                findings.append(
                    AgentFinding(
                        file=str(item["file"]),
                        line=max(1, int(item["line"])),
                        issue_title=str(item["issue_title"]),
                        explanation=str(item["explanation"]),
                        severity=severity,
                        fix_suggestion=str(item["fix_suggestion"]),
                        confidence=confidence,
                        agent=str(item.get("agent", fallback_agent)),
                    )
                )
            except Exception:
                continue
        return findings

    def _build_sample(self, parsed_files: list[dict[str, Any]], focus_name: str) -> list[dict[str, str]]:
        """
        Build the code payload for one agent call.

        Snippets are capped at ``review_max_snippet_chars`` (2500 by default, down from
        7000) because the previous payload was ~56 KB per agent and most of it was
        irrelevant to the agent reading it.
        """
        max_chars = settings.review_max_snippet_chars
        max_files = settings.review_max_llm_files
        allowed_paths = {item["path"] for item in parsed_files}

        focus_query = f"{focus_name} code risks, vulnerabilities, defects, anti-patterns"
        context_hits = self.rag.retrieve(focus_query, k=12)

        by_path: dict[str, list[str]] = {}
        for hit in context_hits:
            path = hit.get("path", "")
            # Retrieval is repo-wide; keep only what routing selected for this agent.
            if not path or path not in allowed_paths:
                continue
            by_path.setdefault(path, []).append(hit.get("text", ""))

        sample: list[dict[str, str]] = []
        for path, snippets in by_path.items():
            merged = "\n".join(snippets)[:max_chars]
            if merged.strip():
                sample.append({"path": path, "snippet": merged})

        # Backfill with the routed files themselves so a weak RAG hit rate never
        # leaves an agent with nothing to read.
        seen = {s["path"] for s in sample}
        for item in parsed_files:
            if len(sample) >= max_files:
                break
            if item["path"] in seen:
                continue
            snippet = item.get("content", "")[:max_chars]
            if snippet.strip():
                sample.append({"path": item["path"], "snippet": snippet})

        return sample[:max_files]

    def _parse_json_array(self, text: str) -> list[dict[str, Any]]:
        cleaned = self._strip_fences(text)
        start = cleaned.find("[")
        end = cleaned.rfind("]")
        if start == -1 or end == -1 or end <= start:
            return []
        try:
            parsed = json.loads(cleaned[start : end + 1])
            return parsed if isinstance(parsed, list) else []
        except json.JSONDecodeError:
            return []

    def _parse_json_object(self, text: str) -> dict[str, Any] | None:
        cleaned = self._strip_fences(text)
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start == -1 or end == -1 or end <= start:
            return None
        try:
            parsed = json.loads(cleaned[start : end + 1])
            return parsed if isinstance(parsed, dict) else None
        except json.JSONDecodeError:
            return None

    @staticmethod
    def _strip_fences(text: str) -> str:
        cleaned = text.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.strip("`")
            if cleaned.startswith("json"):
                cleaned = cleaned[4:].strip()
        return cleaned

    def _fallback_summary(self, findings: list[AgentFinding]) -> str:
        if not findings:
            return "No significant issues found in this diff. Looks clean."
        critical_high = [f for f in findings if f.severity in {"critical", "high"}][:3]
        if critical_high:
            top_item = critical_high[0]
            lines = "\n".join(
                f"- {f.issue_title} ({f.file}:{f.line})" for f in critical_high
            )
            return (
                f"There are {len(critical_high)} high-priority issue(s) that should be resolved before merge. "
                f"Most urgent: {top_item.issue_title} in {top_item.file}:{top_item.line}. "
                f"Remaining items:\n{lines}"
            )
        top = findings[:3]
        lines = "\n".join(f"- {f.issue_title} ({f.file}:{f.line})" for f in top)
        return f"A few items worth addressing before this lands:\n{lines}"

    def _dedupe_findings(self, findings: list[Any]) -> list[Any]:
        seen = set()
        unique = []
        for f in findings:
            key = (f.file, f.line, f.issue_title)
            if key in seen:
                continue
            seen.add(key)
            unique.append(f)
        unique.sort(key=lambda x: (SEVERITY_ORDER.get(x.severity, 0), x.confidence), reverse=True)
        return unique[:40]

    def _apply_persona(self, findings: list[AgentFinding], persona: str) -> list[AgentFinding]:
        explanation_suffix = persona_explanation_suffix(persona)
        fix_suffix = persona_fix_suffix(persona)

        for finding in findings:
            if explanation_suffix and explanation_suffix not in finding.explanation:
                finding.explanation = f"{finding.explanation} {explanation_suffix}"
            if fix_suffix and fix_suffix not in finding.fix_suggestion:
                finding.fix_suggestion = f"{finding.fix_suggestion} {fix_suffix}"
        return findings
