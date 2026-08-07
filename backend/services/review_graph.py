"""
LangGraph orchestration for the multi-agent code review pipeline.

Replaces the old sequential ``for agent in AGENT_PROMPTS: await nim.chat(...)`` loop in
``ReviewService``. The pipeline is genuinely a state machine — classify, branch, fan out,
merge, conditionally escalate — so it is expressed as one, rather than as nested ``if``
statements around an ``await`` chain.

LangGraph is used purely for orchestration. All LLM I/O still goes through the existing
``NIMClient`` (rate limiting, retries, backoff, connection pooling).

Graph shape::

    START
      │
      ▼
    preprocess ──────────► rule-based agents + repository classification (no LLM)
      │
      ▼
    route ───────────────► picks the execution strategy
      │
      ├── "skip"   ─────────────────────────────► aggregate      (docs-only: 0 LLM calls)
      ├── "fast"   ──► quick_review ────────────► aggregate      (small diff: 1 LLM call)
      └── "agents" ──► parallel_agents ─────────► aggregate      (N selected agents,
      │                                                            concurrent, + structure
      ▼                                                            + file summaries)
    aggregate ───────────► dedupe + confidence sort + persona voice
      │
      ▼
    escalate ────────────► chooses synthesis model (strong vs fast)
      │
      ▼
    summarize ───────────► final summary
      │
      ▼
     END
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import TYPE_CHECKING, Any, Literal, TypedDict

from langgraph.graph import END, START, StateGraph

from agents.base_agent import AgentFinding, SEVERITY_ORDER
from backend.services import review_routing
from backend.utils.settings import settings

if TYPE_CHECKING:  # pragma: no cover - import cycle guard
    from backend.services.review_service import ReviewService

logger = logging.getLogger(__name__)

RouteDecision = Literal["skip", "fast", "agents"]

# Escalate final synthesis to the stronger model when the review found something that
# actually warrants careful wording, or when the repository is large enough that a
# naive summary would miss the point.
ESCALATION_COMPLEXITY_FILES = 20


class ReviewState(TypedDict, total=False):
    # Inputs
    parsed_files: list[dict[str, Any]]
    persona: str

    # Derived by preprocess
    profile: review_routing.RepoProfile
    rule_findings: list[AgentFinding]

    # Derived by routing / LLM stage
    route: RouteDecision
    selected_agents: list[str]
    llm_findings: list[AgentFinding]
    structure_context: dict[str, Any]
    file_summaries: dict[str, str]
    summary_seed: str

    # Derived by aggregate / escalate / summarize
    findings: list[AgentFinding]
    summary_model: str
    escalated: bool
    escalation_reason: str
    summary: str

    # Bookkeeping
    rag_index: dict[str, int]
    timings: dict[str, float]
    llm_calls: int


def _build_graph() -> Any:
    graph = StateGraph(ReviewState)

    graph.add_node("preprocess", _node_preprocess)
    graph.add_node("route", _node_route)
    graph.add_node("quick_review", _node_quick_review)
    graph.add_node("parallel_agents", _node_parallel_agents)
    graph.add_node("aggregate", _node_aggregate)
    graph.add_node("escalate", _node_escalate)
    graph.add_node("summarize", _node_summarize)

    graph.add_edge(START, "preprocess")
    graph.add_edge("preprocess", "route")
    graph.add_conditional_edges(
        "route",
        _select_branch,
        {
            "skip": "aggregate",
            "fast": "quick_review",
            "agents": "parallel_agents",
        },
    )
    graph.add_edge("quick_review", "aggregate")
    graph.add_edge("parallel_agents", "aggregate")
    graph.add_edge("aggregate", "escalate")
    graph.add_edge("escalate", "summarize")
    graph.add_edge("summarize", END)

    return graph.compile()


_COMPILED_GRAPH: Any | None = None
# ReviewService is passed through a module-global rather than through graph state so the
# state stays serializable (LangGraph checkpointers must be able to encode it).
_SERVICE: ReviewService | None = None


def _service() -> ReviewService:
    if _SERVICE is None:
        raise RuntimeError("Review graph invoked without a bound ReviewService")
    return _SERVICE


# ── Nodes ─────────────────────────────────────────────────────────────────────


async def _node_preprocess(state: ReviewState) -> dict[str, Any]:
    """Deterministic work only: rule-based agents and cheap classification. No LLM."""
    started = time.perf_counter()
    service = _service()
    parsed_files = state["parsed_files"]
    persona = state["persona"]

    profile = review_routing.classify(parsed_files)
    rule_findings = service.orchestrator.run(parsed_files, persona)

    elapsed = time.perf_counter() - started
    logger.info(
        "Graph node | preprocess | rule_findings=%d elapsed_ms=%d | %s",
        len(rule_findings), int(elapsed * 1000), profile.describe(),
    )
    return {
        "profile": profile,
        "rule_findings": rule_findings,
        "timings": {"preprocess": elapsed},
        "llm_calls": 0,
    }


async def _node_route(state: ReviewState) -> dict[str, Any]:
    """Classify the change and choose how much LLM work it actually deserves."""
    profile = state["profile"]
    service = _service()

    if not service.nim.enabled:
        logger.info("Graph node | route -> skip (NIM disabled)")
        return {"route": "skip", "selected_agents": []}

    selected = review_routing.select_agents(profile)
    if not selected:
        return {"route": "skip", "selected_agents": []}

    if review_routing.should_use_fast_path(profile):
        logger.info("Graph node | route -> fast (small change: 1 LLM call)")
        return {"route": "fast", "selected_agents": [a.name for a in selected]}

    logger.info(
        "Graph node | route -> agents (%d concurrent: %s)",
        len(selected), ", ".join(a.name for a in selected),
    )
    return {"route": "agents", "selected_agents": [a.name for a in selected]}


def _select_branch(state: ReviewState) -> str:
    return state.get("route", "skip")


async def _node_quick_review(state: ReviewState) -> dict[str, Any]:
    """Fast path: structure + a single combined findings/summary call, run concurrently."""
    started = time.perf_counter()
    service = _service()
    parsed_files = state["parsed_files"]
    persona = state["persona"]

    structure_context = await service.structure.derive(parsed_files)
    pack, file_summaries = await asyncio.gather(
        service.quick_review(parsed_files, persona, structure_context),
        service.generate_file_summaries(parsed_files),
        return_exceptions=True,
    )

    if isinstance(pack, BaseException):
        logger.warning("Graph node | quick_review failed: %s", pack)
        pack = None
    if isinstance(file_summaries, BaseException):
        logger.warning("Graph node | file summaries failed: %s", file_summaries)
        file_summaries = {}

    llm_findings: list[AgentFinding] = []
    summary_seed = ""
    if pack:
        llm_findings = service._coerce_findings(pack.get("findings", []), fallback_agent="Quick Review")
        summary_seed = str(pack.get("summary", "")).strip()

    elapsed = time.perf_counter() - started
    logger.info(
        "Graph node | quick_review | findings=%d elapsed_ms=%d",
        len(llm_findings), int(elapsed * 1000),
    )
    return {
        "llm_findings": llm_findings,
        "structure_context": structure_context,
        "file_summaries": file_summaries or {},
        "summary_seed": summary_seed,
        "timings": {**state.get("timings", {}), "llm_stage": elapsed},
        "llm_calls": state.get("llm_calls", 0) + 3,
    }


async def _node_parallel_agents(state: ReviewState) -> dict[str, Any]:
    """
    The core fix: every selected agent, the structure analysis, and the file-summary
    batch all issue their LLM calls concurrently.

    Wall clock is now roughly one slow call (bounded by ``NIM_MAX_CONCURRENCY`` and the
    RPM pacer) instead of the sum of eight.
    """
    started = time.perf_counter()
    service = _service()
    parsed_files = state["parsed_files"]
    persona = state["persona"]

    from backend.services.review_prompts import AGENT_PROMPTS_BY_NAME

    agents = [
        AGENT_PROMPTS_BY_NAME[name]
        for name in state.get("selected_agents", [])
        if name in AGENT_PROMPTS_BY_NAME
    ]

    tasks: list[Any] = [service.run_agent(agent, parsed_files, persona) for agent in agents]
    tasks.append(service.structure.derive(parsed_files))
    tasks.append(service.generate_file_summaries(parsed_files))

    results = await asyncio.gather(*tasks, return_exceptions=True)

    agent_results = results[: len(agents)]
    structure_result = results[len(agents)]
    summaries_result = results[len(agents) + 1]

    llm_findings: list[AgentFinding] = []
    failed = 0
    for agent, outcome in zip(agents, agent_results):
        if isinstance(outcome, BaseException):
            # One agent failing must not sink the review; the others already ran.
            logger.warning("Graph node | agent %s failed: %s", agent.name, outcome)
            failed += 1
            continue
        llm_findings.extend(outcome)

    structure_context = {} if isinstance(structure_result, BaseException) else structure_result
    if isinstance(structure_result, BaseException):
        logger.warning("Graph node | structure analysis failed: %s", structure_result)

    file_summaries = {} if isinstance(summaries_result, BaseException) else (summaries_result or {})
    if isinstance(summaries_result, BaseException):
        logger.warning("Graph node | file summaries failed: %s", summaries_result)

    elapsed = time.perf_counter() - started
    logger.info(
        "Graph node | parallel_agents | agents=%d failed=%d findings=%d elapsed_ms=%d",
        len(agents), failed, len(llm_findings), int(elapsed * 1000),
    )
    return {
        "llm_findings": llm_findings,
        "structure_context": structure_context,
        "file_summaries": file_summaries,
        "summary_seed": "",
        "timings": {**state.get("timings", {}), "llm_stage": elapsed},
        "llm_calls": state.get("llm_calls", 0) + len(tasks),
    }


async def _node_aggregate(state: ReviewState) -> dict[str, Any]:
    """Merge rule + LLM findings using the existing dedup/sort/persona logic, unchanged."""
    service = _service()
    combined = list(state.get("rule_findings", [])) + list(state.get("llm_findings", []))
    findings = service._dedupe_findings(combined)
    findings = service._apply_persona(findings, state["persona"])

    logger.info("Graph node | aggregate | merged=%d unique=%d", len(combined), len(findings))
    return {"findings": findings}


async def _node_escalate(state: ReviewState) -> dict[str, Any]:
    """
    Pick the model that writes the final synthesis.

    Critical findings and large repositories get the stronger model; routine reviews stay
    on the fast one so the common case does not pay for the rare case.
    """
    findings = state.get("findings", [])
    profile = state.get("profile")

    has_critical = any(f.severity == "critical" for f in findings)
    high_count = sum(1 for f in findings if f.severity in {"critical", "high"})
    is_complex = bool(profile and profile.file_count > ESCALATION_COMPLEXITY_FILES)

    reasons = []
    if has_critical:
        reasons.append("critical findings present")
    if high_count >= 5:
        reasons.append(f"{high_count} high-severity findings")
    if is_complex:
        reasons.append(f"{profile.file_count} files analysed")

    if reasons:
        model = settings.nim_model_neotron
        logger.info("Graph node | escalate | strong model selected (%s)", "; ".join(reasons))
        return {"summary_model": model, "escalated": True, "escalation_reason": "; ".join(reasons)}

    logger.info("Graph node | escalate | fast model retained")
    return {
        "summary_model": settings.nim_model_qwen_review,
        "escalated": False,
        "escalation_reason": "",
    }


async def _node_summarize(state: ReviewState) -> dict[str, Any]:
    """Produce the final summary, reusing the fast path's summary when one exists."""
    started = time.perf_counter()
    service = _service()

    seed = state.get("summary_seed", "")
    if seed:
        logger.info("Graph node | summarize | reused fast-path summary (0 extra LLM calls)")
        return {"summary": seed, "timings": {**state.get("timings", {}), "summarize": 0.0}}

    summary = await service.summarize_findings(
        state.get("findings", []),
        state["persona"],
        state.get("structure_context", {}),
        model=state.get("summary_model"),
    )

    elapsed = time.perf_counter() - started
    logger.info("Graph node | summarize | elapsed_ms=%d", int(elapsed * 1000))
    return {
        "summary": summary,
        "timings": {**state.get("timings", {}), "summarize": elapsed},
        # Only count a call that could actually have been issued.
        "llm_calls": state.get("llm_calls", 0) + (1 if service.nim.enabled else 0),
    }


# ── Entrypoint ────────────────────────────────────────────────────────────────


async def run_review_graph(
    service: ReviewService,
    parsed_files: list[dict[str, Any]],
    persona: str,
) -> dict[str, Any]:
    """Run the compiled review graph and shape its state into the API response dict."""
    global _COMPILED_GRAPH, _SERVICE

    _SERVICE = service
    if _COMPILED_GRAPH is None:
        _COMPILED_GRAPH = _build_graph()

    started = time.perf_counter()
    final: ReviewState = await _COMPILED_GRAPH.ainvoke(
        {"parsed_files": parsed_files, "persona": persona}
    )
    total_elapsed = time.perf_counter() - started

    findings = final.get("findings", [])
    profile = final.get("profile")

    severity_counts: dict[str, int] = {"critical": 0, "high": 0, "medium": 0, "low": 0}
    for finding in findings:
        if finding.severity in severity_counts:
            severity_counts[finding.severity] += 1

    logger.info(
        "Review graph complete | route=%s llm_calls=%d findings=%d elapsed_ms=%d",
        final.get("route"), final.get("llm_calls", 0), len(findings), int(total_elapsed * 1000),
    )

    return {
        "findings": [f.__dict__ for f in findings],
        "summary": final.get("summary", ""),
        "reviewed_files": [item["path"] for item in parsed_files],
        "file_summaries": final.get("file_summaries", {}),
        "file_symbols": service.collect_file_symbols(parsed_files),
        "metadata": {
            "agent_count": len(service.orchestrator.agents),
            "nim_enabled": service.nim.enabled,
            "structure": final.get("structure_context", {}),
            "mode": "langgraph",
            "graph": {
                "route": final.get("route", "skip"),
                "selected_agents": final.get("selected_agents", []),
                "escalated": final.get("escalated", False),
                "escalation_reason": final.get("escalation_reason", ""),
                "llm_calls": final.get("llm_calls", 0),
                "elapsed_seconds": round(total_elapsed, 2),
                "timings": {k: round(v, 2) for k, v in final.get("timings", {}).items()},
            },
            "routing": profile.describe() if profile else "",
            "severity_counts": severity_counts,
        },
    }


def graph_severity_rank(finding: AgentFinding) -> int:
    """Exposed for tests: confirms the graph reuses the existing severity ordering."""
    return SEVERITY_ORDER.get(finding.severity, 0)
