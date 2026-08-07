# AGENTS LANGGRAPH REFACTOR — MASTER PROMPT

## CONTEXT

You are working on the **Cypher AI** project (`Hack_Genesis_hackathon` repo), currently on the `samarth` branch.

The repository is an AI-powered code-review platform. The `agents/` folder currently contains 6 pure-Python rule-based agents and one orchestrator. This prompt upgrades them.

### CRITICAL RULES — READ BEFORE WRITING ANY CODE
1. **Do NOT change `AgentFinding` dataclass** — it is the shared data contract used everywhere
2. **Do NOT change `SEVERITY_ORDER`** — used by the LangGraph pipeline and sorting logic
3. **Do NOT change any FastAPI routes** in `backend/main.py`
4. **Do NOT change `review_graph.py`** — LangGraph already orchestrates the review pipeline there
5. **Do NOT change personas, RAG, or docs generation**
6. **The project idea stays identical** — same code review platform, same outputs
7. Every change must leave the system runnable (`uvicorn backend.main:app --reload` starts)

---

## CURRENT STATE — WHAT EXISTS

### `agents/base_agent.py`
```python
@dataclass
class AgentFinding:
    file: str
    line: int
    issue_title: str
    explanation: str
    severity: str
    fix_suggestion: str
    confidence: float
    agent: str

class BaseAgent:
    name = "base"
    min_confidence = 0.7

    def analyze(self, parsed_files, persona) -> list[AgentFinding]:
        raise NotImplementedError

    def _emit(self, *, file, line, issue_title, explanation, severity, fix_suggestion, confidence) -> AgentFinding | None:
        # returns None if confidence < min_confidence
```

### `agents/orchestrator.py`
```python
class ReviewOrchestrator:
    def __init__(self):
        self.agents = [BugSafetyAgent(), SecurityAgent(), PerformanceAgent(),
                       ReadabilityDocsAgent(), ArchitectureAgent(), AccessibilityAgent()]

    def run(self, parsed_files, persona) -> list[AgentFinding]:
        # calls each agent.analyze() sequentially
        # sorts by severity + confidence
        # deduplicates by (file, line, title)
        # returns top 40
```

### The 6 agents in `agents/`
Each agent has `analyze(parsed_files, persona) -> list[AgentFinding]` using:
- Pure Python `re.search()` pattern matching
- String keyword scanning
- No LLM calls whatsoever

### What calls `orchestrator.run()` today
In `backend/services/review_graph.py`, the `_node_preprocess` LangGraph node calls:
```python
rule_findings = service.orchestrator.run(parsed_files, persona)
```

---

## WHAT TO BUILD

### The Core Idea
Each agent should combine two things into one unified analysis:
1. **Rule-based scan** (keep exactly as-is — fast, reliable, zero LLM cost)
2. **Targeted LLM analysis** (new — agent-specific prompt, focused on its domain)

The orchestrator should run all 6 agents **in parallel** using a LangGraph `StateGraph`.

---

## IMPLEMENTATION PLAN

### Step 1 — Upgrade `BaseAgent` (`agents/base_agent.py`)

Add an async method alongside the existing sync `analyze()`:

```python
async def analyze_with_llm(
    self,
    parsed_files: list[dict],
    persona: str,
    nim_client,           # NIMClient instance
    agent_prompt,         # AgentPrompt from review_prompts.py
    file_selector,        # callable: (agent_prompt, parsed_files) -> list[dict]
    snippet_builder,      # callable: (files) -> str
    model: str,
) -> list[AgentFinding]:
    """
    Default implementation:
    1. Call self.analyze() for rule-based findings
    2. Build a focused prompt using agent_prompt.instructions + code snippets
    3. Call nim_client.chat() with kind="agent"
    4. Parse LLM JSON response into AgentFinding objects
    5. Merge rule + LLM findings, dedup by (file, line, title), return combined
    """
```

- Rule-based findings always run first (they never fail)
- LLM findings are additive — if LLM call fails/times out, rule findings are still returned
- Each agent can override `analyze_with_llm()` if it needs special logic
- Use the existing `_emit()` method for LLM findings too (for confidence filtering)

### Step 2 — New file: `agents/agent_graph.py`

Create a new LangGraph `StateGraph` that replaces `ReviewOrchestrator.run()`:

```python
"""
agents/agent_graph.py

LangGraph StateGraph for parallel, enriched agent execution.

Shape:
    START
      │
      ├─────────────────────────────────────────────────┐
      │                                                  │
    bug_node   security_node   perf_node   ...   accessibility_node
      │              │              │                    │
      └──────────────┴──────────────┴────────────────────┘
                                │
                           aggregate_node
                                │
                               END
"""
```

**State definition:**
```python
class AgentGraphState(TypedDict, total=False):
    parsed_files: list[dict]
    persona: str
    # Each agent writes its own findings key
    bug_findings: list[AgentFinding]
    security_findings: list[AgentFinding]
    performance_findings: list[AgentFinding]
    readability_findings: list[AgentFinding]
    architecture_findings: list[AgentFinding]
    accessibility_findings: list[AgentFinding]
    # Final merged output
    findings: list[AgentFinding]
    timings: dict[str, float]
    llm_calls: int
```

**Each agent node:**
```python
async def _node_bug(state: AgentGraphState) -> dict:
    started = time.perf_counter()
    agent = BugSafetyAgent()
    findings = await agent.analyze_with_llm(
        parsed_files=state["parsed_files"],
        persona=state["persona"],
        nim_client=_get_nim(),       # shared singleton
        agent_prompt=AGENT_PROMPTS_BY_NAME["Bug & Safety"],
        file_selector=select_files_for_agent,
        snippet_builder=_build_snippet,
        model=settings.nim_model_qwen_review,
    )
    elapsed = time.perf_counter() - started
    logger.info("Agent node | Bug & Safety | findings=%d elapsed_ms=%d", len(findings), int(elapsed * 1000))
    return {"bug_findings": findings, "timings": {**state.get("timings", {}), "bug": elapsed}}
```

**Aggregate node** (merges all 6 agents, same logic as current `orchestrator.run()`):
```python
async def _node_aggregate(state: AgentGraphState) -> dict:
    combined = (
        state.get("bug_findings", []) +
        state.get("security_findings", []) +
        state.get("performance_findings", []) +
        state.get("readability_findings", []) +
        state.get("architecture_findings", []) +
        state.get("accessibility_findings", [])
    )
    # Sort by severity + confidence (same as current)
    combined.sort(key=lambda f: (SEVERITY_ORDER.get(f.severity, 0), f.confidence, -f.line), reverse=True)
    # Dedup by (file, line, title) (same as current)
    seen = set()
    unique = []
    for f in combined:
        key = (f.file, f.line, f.issue_title)
        if key not in seen:
            seen.add(key)
            unique.append(f)
    return {"findings": unique[:40]}
```

**Graph wiring:**
```python
def _build_agent_graph():
    graph = StateGraph(AgentGraphState)
    
    # Add all 6 agent nodes
    graph.add_node("bug", _node_bug)
    graph.add_node("security", _node_security)
    graph.add_node("performance", _node_performance)
    graph.add_node("readability", _node_readability)
    graph.add_node("architecture", _node_architecture)
    graph.add_node("accessibility", _node_accessibility)
    graph.add_node("aggregate", _node_aggregate)
    
    # All agents run from START in parallel (fan-out)
    graph.add_edge(START, "bug")
    graph.add_edge(START, "security")
    graph.add_edge(START, "performance")
    graph.add_edge(START, "readability")
    graph.add_edge(START, "architecture")
    graph.add_edge(START, "accessibility")
    
    # All agents converge to aggregate (fan-in)
    graph.add_edge("bug", "aggregate")
    graph.add_edge("security", "aggregate")
    graph.add_edge("performance", "aggregate")
    graph.add_edge("readability", "aggregate")
    graph.add_edge("architecture", "aggregate")
    graph.add_edge("accessibility", "aggregate")
    
    graph.add_edge("aggregate", END)
    return graph.compile()
```

**Public entrypoint:**
```python
async def run_agent_graph(
    parsed_files: list[dict],
    persona: str,
) -> list[AgentFinding]:
    """Drop-in replacement for ReviewOrchestrator.run() but async and parallel."""
    graph = _get_compiled_graph()
    final: AgentGraphState = await graph.ainvoke({
        "parsed_files": parsed_files,
        "persona": persona,
    })
    return final.get("findings", [])
```

### Step 3 — Update `agents/orchestrator.py`

Keep `ReviewOrchestrator.run()` as a sync wrapper (for backward compatibility with any code that calls it synchronously):

```python
class ReviewOrchestrator:
    def __init__(self):
        self.agents = [...]  # keep the list (used for metadata: agent_count)

    def run(self, parsed_files, persona) -> list[AgentFinding]:
        """
        Sync fallback: runs rule-based agents only.
        Called by review_graph.py _node_preprocess for fast rule checks.
        The enriched parallel version is run_agent_graph() in agent_graph.py.
        """
        # Keep exactly as-is. This is still the fast Python-only pass.
        ...

    async def run_async(self, parsed_files, persona) -> list[AgentFinding]:
        """
        Async enriched version: calls agent_graph.run_agent_graph().
        Called when you want both rule + LLM per agent.
        """
        from agents.agent_graph import run_agent_graph
        return await run_agent_graph(parsed_files, persona)
```

### Step 4 — Update `_node_preprocess` in `review_graph.py`

The `_node_preprocess` node currently calls `service.orchestrator.run()` (sync, rule-only).

Change it to call `service.orchestrator.run_async()` (async, rule + LLM, parallel):

```python
async def _node_preprocess(state: ReviewState) -> dict:
    """Now uses the enriched parallel agent graph instead of sequential rule-only scan."""
    started = time.perf_counter()
    service = _service()
    parsed_files = state["parsed_files"]
    persona = state["persona"]

    profile = review_routing.classify(parsed_files)

    # Run the full enriched agent graph (rule + LLM per agent, all parallel)
    rule_findings = await service.orchestrator.run_async(parsed_files, persona)

    elapsed = time.perf_counter() - started
    logger.info(
        "Graph node | preprocess (enriched) | findings=%d elapsed_ms=%d | %s",
        len(rule_findings), int(elapsed * 1000), profile.describe(),
    )
    return {
        "profile": profile,
        "rule_findings": rule_findings,
        "timings": {"preprocess": elapsed},
        "llm_calls": 0,
    }
```

**IMPORTANT**: Because `_node_preprocess` now runs enriched agent analysis, the `_node_parallel_agents` node in `review_graph.py` may overlap in work. To avoid duplication:
- `_node_preprocess` → enriched agents (rule + focused LLM per agent)
- `_node_parallel_agents` → can be simplified to only run structure analysis + file summaries (no per-agent LLM calls, since those now happen in preprocess)
- OR: Use the routing logic to decide — if NIM is enabled and agents ran, skip `_node_parallel_agents`; if NIM is disabled, `_node_parallel_agents` gracefully does nothing

---

## FILE CHANGES SUMMARY

| File | Change | Risk |
|---|---|---|
| `agents/base_agent.py` | Add `analyze_with_llm()` async method | Low — additive only |
| `agents/agent_graph.py` | **NEW** — LangGraph StateGraph with 6 agent nodes + aggregate | Medium |
| `agents/orchestrator.py` | Add `run_async()` wrapper | Low — existing `run()` unchanged |
| `backend/services/review_graph.py` | `_node_preprocess` calls `run_async()` | Medium |
| `backend/services/review_service.py` | No change needed | None |
| `agents/*.py` (6 agents) | Optionally override `analyze_with_llm()` for specialised behaviour | Low |

---

## LLM CALL DESIGN PER AGENT

Each agent should receive **only the files relevant to it** (already implemented in `review_routing.select_files_for_agent()`).

Prompt structure for each agent's LLM call:
```
System: "You are a specialized {agent.name} reviewer. {agent.focus}
{agent.instructions}
{COMMON_CONSTRAINTS}
{JSON_SCHEMA_GUIDE}"

User: "Review these code files and return findings as JSON:
{code_snippets — max 2500 chars per file, only agent-relevant files}"
```

Parse the JSON response with the same `_coerce_findings()` logic already in `review_service.py`.

---

## WHAT STAYS COMPLETELY UNCHANGED

- `AgentFinding` dataclass fields
- `SEVERITY_ORDER` dict
- `BaseAgent._emit()` method
- `BaseAgent.min_confidence`
- All 6 agent `analyze()` methods (rule-based logic)
- All FastAPI routes
- `RAGPipeline`
- `NIMClient`
- `review_routing.py`
- `review_prompts.py` (AGENT_PROMPTS, COMMON_CONSTRAINTS, JSON_SCHEMA_GUIDE)
- All frontend code
- Persona system
- Docs generation

---

## EXPECTED IMPROVEMENTS AFTER THIS CHANGE

| Metric | Before | After |
|---|---|---|
| **Findings source** | Rule-based OR LLM (separate) | Rule + LLM combined per agent |
| **Agent execution** | Sequential in preprocess | Parallel via LangGraph fan-out |
| **Finding quality** | LLM misses what rules catch, rules miss what LLM catches | Both combined = fewer false negatives |
| **Architecture clarity** | Agents and LLM calls are disconnected | Each agent owns its full analysis |

---

## TESTING AFTER IMPLEMENTATION

1. Start the backend: `uvicorn backend.main:app --reload`
2. Submit a GitHub repo URL to `/api/review/repo`
3. Poll `/api/jobs/{job_id}` until complete
4. Verify:
   - Response contains `findings[]` array
   - Each finding has `agent` field matching an agent name
   - `metadata.mode` = `"langgraph"`
   - No 500 errors in logs
5. Set `NIM_API_KEY=""` and verify fallback works (rule-only findings still returned)

---

## IMPORTANT CONSTRAINTS

1. `langgraph>=0.2,<2` is already in `backend/requirements.txt`
2. Use `get_nim_client()` from `backend/services/nim_client.py` — do NOT create a new client
3. Use `select_files_for_agent()` from `backend/services/review_routing.py` — do NOT re-implement file selection
4. Use `AGENT_PROMPTS_BY_NAME` from `backend/services/review_prompts.py` — do NOT duplicate prompts
5. All LLM calls must use `call_kind="agent"` (45s timeout, 1024 max tokens)
6. If LLM call returns None or fails, return only rule-based findings — never crash
7. The `run()` sync method on `ReviewOrchestrator` must remain identical
