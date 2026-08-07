# CYPHER AI — MASTER REFACTOR PROMPT

## CONTEXT

You are a senior AI systems architect, backend performance engineer, UI/UX engineer, and code-review platform engineer working on **Cypher AI** (also known as CODECLIPSE in the engineering context).

The repository is a full-stack AI-powered GitHub code-review and documentation generation platform with:

- **Frontend**: Next.js (App Router), TypeScript, GSAP animations, terminal-aesthetic UI
- **Backend**: FastAPI (Python), async background jobs, Redis job store
- **AI Layer**: NVIDIA NIM APIs (Qwen 2.5 Coder for review, Qwen/Neotron for docs)
- **Agents**: 6 rule-based agents (Bug, Security, Performance, Readability, Architecture, Accessibility) orchestrated by `ReviewOrchestrator`
- **RAG**: In-memory vector store for context retrieval
- **GitHub Integration**: Webhooks, PR diffs, inline comments, GitHub App JWT auth
- **Docs**: README generation, dependency graphs, modular docs, onboarding guides

### CRITICAL RULE
**Do NOT change the core idea, business logic, or feature set.** Improve, optimize, and enhance — never replace or remove working functionality. Every change must leave the system more runnable than before.

---

## PART 1 — THE 5 MANDATORY IMPROVEMENTS

These are the primary goals. Everything else serves these.

### IMPROVEMENT 1 — REPLACE MULTI-AGENT SEQUENTIAL CALLS WITH LANGGRAPH

**Current problem:**  
In `backend/services/review_service.py`, `ReviewService.review()` runs:
1. `self.orchestrator.run()` — 6 rule-based agents sequentially in `agents/orchestrator.py`
2. `await self._qwen_review_pass()` — LLM called 6 times **sequentially** (once per `AgentPrompt` in `AGENT_PROMPTS`)
3. `await self._summarize_findings()` — another LLM call

Total: up to **8 sequential LLM calls** per review. This is the primary source of latency and timeouts.

**What to do:**
- Introduce **LangGraph** (package: `langgraph`) to orchestrate the multi-agent pipeline
- Build a LangGraph `StateGraph` where:
  - **Node 1**: Deterministic preprocessing (rule-based agents — these are fast Python, keep them)
  - **Node 2**: Smart routing — classify the diff/files to determine WHICH LLM agents are actually needed (e.g., CSS-only change skips security agent)
  - **Node 3 (parallel)**: Run the selected LLM agents concurrently using `asyncio.gather()` within the LangGraph node — NOT sequentially
  - **Node 4**: Aggregation — dedup + confidence filter (already exists, keep it)
  - **Node 5**: Conditional escalation — if critical findings exist OR complexity is high, escalate to a stronger model for final synthesis; otherwise use fast model
  - **Node 6**: Summary generation
- The LangGraph graph replaces the current `_qwen_review_pass` + `_summarize_findings` sequential flow
- Keep `ReviewOrchestrator` for rule-based agents (they are fast, no LLM, no change needed)
- Keep `AgentFinding` dataclass, `SEVERITY_ORDER`, deduplication logic — all unchanged
- The LangGraph state should carry: `parsed_files`, `persona`, `rule_findings`, `llm_findings`, `summary`, `structure_context`, `rag_index`
- Add a `langgraph` and `langchain-core` to `backend/requirements.txt`

**Do NOT use LangChain for basic HTTP calls** — the existing `NIMClient` in `backend/services/nim_client.py` works well (has rate limiting, retries, backoff). LangGraph nodes should call `NIMClient.chat()` internally.

**Agent routing logic** (implement this):
```
If diff/files are CSS/HTML/style only → skip Security, Bug, Architecture agents
If diff/files are docs/markdown only → skip all LLM agents, return empty findings fast
If file count > 20 → sample top 10 by complexity score for LLM agents
If any file contains auth/crypto/sql keywords → always include Security agent
If total line changes < 50 → use fast single-pass review instead of multi-agent
```

---

### IMPROVEMENT 2 — ADD "CODE EXPLAINER" SECTION TO REVIEW RESULTS UI

**Current problem:**  
The dashboard (`frontend/app/dashboard/page.tsx`) shows findings as a raw list in `ReviewResults.tsx`. Non-engineers or juniors struggle to understand WHAT the code actually does and WHY a finding matters.

**What to do:**
Add a new **"Code Explainer"** tab/section in the Review Results panel. This section should:

1. **Plain-English File Summary cards**: For each reviewed file, show a card with:
   - File name (styled as a terminal path badge)
   - What this file does (1-2 sentences, LLM-generated, cached per run)
   - Key functions/classes detected (from parsed `functions[]` and `classes[]` already in the data)
   - Risk level pill (derived from finding severities in that file)

2. **Finding Deep-Dives**: Each finding in the existing list gets an expandable "Explain More" drawer that shows:
   - **What the code does** (plain English, 2-3 sentences)
   - **Why this is a problem** (explain severity in human terms)
   - **How to fix it** (step-by-step, not just the fix suggestion)
   - A **before/after code diff** styled block (use the `fix_suggestion` field)
   - Severity badge with color coding (red=critical, amber=high, yellow=medium, blue=low)

3. **Summary card at top** showing:
   - Total files reviewed, total findings
   - Severity breakdown as a visual bar (e.g., `■■■□□□□` style)
   - One-line overall health score: "Code Health: 7/10 — Solid, 2 critical issues need attention"

4. **Design requirements**:
   - Match the existing mint-green terminal theme from `globals.css` (`var(--ink)`, `var(--border)`, `var(--success)`, `var(--danger)`, etc.)
   - Use `JetBrains Mono` for code, `Space Grotesk` for prose
   - Smooth expand/collapse animations (CSS transitions, no extra library needed)
   - Do NOT add any new npm packages for this — use existing Next.js + vanilla CSS
   - The section should feel like a "code companion" not a raw data dump

5. **Backend changes needed**:
   - Add a `file_summaries: dict[str, str]` field to `ReviewResponse` schema (in `backend/models/schemas.py`)
   - In `ReviewService.review()`, after rule-based agents complete, generate file summaries for the top 5 most complex files using a single batched LLM call (combine into one prompt, not 5 separate calls)
   - This single call happens in parallel with the LLM agent pass (use `asyncio.gather`)

---

### IMPROVEMENT 3 — COMPLETELY REDESIGN THE GRAPH VISUALIZATION

**Current problem:**  
The current graph (`frontend/components/GraphView.tsx`, `GraphPanel.tsx`) uses a basic canvas/SVG implementation with:
- Manual box dragging required to see anything
- No automatic layout
- Poor visual hierarchy
- No zoom/pan
- Nodes look like plain rectangles
- No color coding by module type
- The split-view/tree-view mode switch is confusing

**What to do:**  
Replace the graph visualization with a self-contained, beautiful, interactive implementation:

1. **Use D3.js force-directed layout** — add `d3` to `frontend/package.json`. The force simulation should:
   - Auto-arrange nodes on load (no manual dragging needed)
   - Nodes repel each other, edges attract — standard force-directed behavior
   - Run simulation for 300 ticks, then freeze (no jittery movement after load)
   - Support smooth zoom + pan (D3 zoom behavior)

2. **Node design**:
   - Circles, not rectangles
   - Color coded by group:
     - `backend/` → mint green (`#A7EF9E`)
     - `frontend/` → cyan (`#5ef8d0`)
     - `agents/` → amber (`#f0c040`)
     - `rag/` → purple (`#bc8cff`)
     - `docs/` → blue (`#60a5fa`)
     - `github/` → red (`#ff5f5f`)
   - Size proportional to `outbound` connections (more connections = larger node)
   - Glow effect on hover using SVG filter
   - Selected node: ring highlight + neighboring nodes stay full opacity, others dim to 20%

3. **Edge design**:
   - Curved arrows (not straight lines)
   - Animated dashes for "active" connections when a node is selected
   - Edge thickness proportional to connection count

4. **Info panel** (replaces current Inspector sidebar):
   - Opens as a slide-in panel from the right when a node is clicked
   - Shows: file path, group, inbound count, outbound count, neighbor list (clickable)
   - "Jump to" button that re-centers graph on selected node

5. **Controls bar** at the top of the graph:
   - Zoom In / Zoom Out / Reset View buttons
   - "Focus on Hotspot" button (auto-selects the densest node)
   - Filter by group buttons (show/hide groups)
   - Node count + edge count stats (inline, no separate stat cards)

6. **Remove**: the current split/graph/tree toggle buttons, the separate stat cards grid, the manual expand toggle. Replace entirely with the above.

7. **Tree view** (`TreeView.tsx`) stays but is accessed via a simple "Tree" tab, not a complex split-view mode.

8. **Performance**: If graph has > 100 nodes, show a "simplified" mode with only nodes that have ≥ 2 connections (filter the rest out with a message "Showing 43/120 nodes — small isolated files hidden").

9. **The graph should be self-explanatory** — a person looking at it for the first time should immediately understand: what files exist, how they relate, which are the most important, and what group/layer they belong to. All this without reading any documentation.

---

### IMPROVEMENT 4 — FIX NIM API LATENCY AND TIMEOUT ISSUES

**Current problems** (visible in `backend/services/nim_client.py` and `backend/services/review_service.py`):

1. **Sequential LLM calls**: `_qwen_review_pass` calls the LLM 6 times in a `for` loop — each waits for the previous. At ~8-15s per call, this is 48-90 seconds total.

2. **Excessively large prompts**: Each agent call sends `json.dumps(sample)` with up to 8 files × 7000 chars = ~56,000 chars per call. Most of this is irrelevant to the specific agent.

3. **Max tokens too high**: `_NIM_MAX_TOKENS` defaults too high, causing the model to generate verbose output that triggers timeouts.

4. **No prompt-level token budget**: Prompts have no instruction to be brief. Models generate verbose explanations when 2 sentences would do.

5. **Rate limiter is blocking concurrency**: The `RateLimiter` uses `asyncio.Lock()` which serializes all concurrent calls even if the API allows concurrency.

6. **httpx client recreated per call**: `async with httpx.AsyncClient(...)` inside `chat()` creates a new connection pool every call.

**Fixes to implement:**

**Fix A — Prompt size reduction**:
- In `_build_sample()`, reduce snippet max from 7000 chars to **2500 chars** per file
- For each agent, only include files relevant to that agent's focus:
  - Security agent → files with `import`, `exec`, `eval`, `request`, `query` patterns
  - Performance agent → files with loops, database calls, list comprehensions
  - Accessibility agent → only `.tsx`, `.jsx`, `.html` files
  - Architecture agent → only files with > 3 imports
- Add this instruction to every agent prompt: `"Keep each finding explanation to 2 sentences maximum. Return ONLY findings with confidence ≥ 0.80."`

**Fix B — Add `max_tokens` cap**:
- Cap `_NIM_MAX_TOKENS` at **1024** for agent review calls (findings are short JSON)
- Use **2048** max tokens only for summary generation

**Fix C — Persistent httpx client**:
- Change `NIMClient` to maintain a persistent `httpx.AsyncClient` as a class attribute (initialized in `__init__`, closed in an explicit `aclose()` method)
- Register cleanup in FastAPI's `on_shutdown` event

**Fix D — Parallel rate limiter**:
- Replace the single global lock with a **semaphore** (`asyncio.Semaphore(3)`) — allows 3 concurrent NIM calls while still respecting rate limits
- Keep the RPM backoff logic but apply it per-token rather than globally locking

**Fix E — Fast-path for simple changes**:
- If total file content < 3000 chars OR only 1 file changed, skip the full multi-agent pass and use a single compact "quick review" prompt that returns findings + summary in one call
- This replaces 6-8 LLM calls with 1

**Fix F — Timeout tuning**:
- Set `_NIM_TIMEOUT` to **45 seconds** for agent calls, **90 seconds** for summary/docs generation
- Add per-agent timeout cancellation: if one agent times out, don't block the others

---

### IMPROVEMENT 5 — PRESERVE ALL EXISTING LOGIC, ROUTING, AND FEATURES

The following must remain completely unchanged or only additively improved:
- All FastAPI routes and their signatures (`/api/review/repo`, `/api/review/upload`, `/api/docs/repo`, `/api/docs/upload`, `/api/github/webhook`, `/api/health`, `/api/jobs/{job_id}`)
- Job system (Redis + in-process fallback)
- `AgentFinding` dataclass and `SEVERITY_ORDER`
- `RAGPipeline` (index + retrieve)
- `ReviewOrchestrator` rule-based agents (6 agents, Python-only, no LLM)
- `DocumentationService` and `docs/readme_generator.py`
- GitHub webhook signature validation
- GitHub App JWT + installation token auth
- Persona system (`Intern`, `Student`, `Frontend Developer`, `Backend Developer`)
- Frontend landing page (`app/page.tsx`) — do NOT touch this
- Frontend dashboard sidebar layout and input modes (repo URL / ZIP)
- All environment variable names (they are configured in deployment)

---

## PART 2 — ARCHITECTURE AUDIT & ENGINEERING REPORT

Before writing any code, produce an engineering report covering:

### 1. Current Architecture Map
Trace the actual call path for:
- **Code review**: `POST /api/review/repo` → final review result
- **Docs generation**: `POST /api/docs/repo` → final README
- **GitHub webhook**: `POST /api/github/webhook` → inline PR comment

Use actual file/function names from the repository.

### 2. Critical Problems (Ranked)
- **P0** (system-breaking): e.g., sequential LLM calls causing guaranteed timeouts on Render
- **P1** (major): e.g., all agents always run even for trivial changes
- **P2** (optimization): e.g., httpx client recreation
- **P3** (cleanup): e.g., dead code, duplicate logic

### 3. LangChain History Investigation
The repo shows no current LangChain code but the engineering prompt mentions a previous failed attempt. Search for:
- Any remnants: `langchain`, `LLMChain`, `invoke`, `ainvoke`, `ChatOpenAI`, `BaseLLM`
- Document what was there and why it was removed or bypassed
- Confirm: was the LLM actually being invoked, or was the call path broken?

### 4. LangGraph vs LangChain vs Custom Python — Decision
Make a concrete recommendation specific to this repo:
- **LangGraph**: recommended for orchestrating the multi-agent review pipeline (conditional routing, parallel nodes, state management)
- **LangChain core**: only if specific abstractions (prompt templates, output parsers) provide clear benefit over existing code
- **Custom Python**: keep for NIMClient, rate limiting, retry logic — already well-implemented
- **Do NOT** use LangChain merely for abstraction. Every dependency must earn its place.

### 5. Latency Analysis
Estimate current vs optimized latency for:
| Operation | Current | After Fixes |
|---|---|---|
| Rule-based agents (6) | ~0.5s | ~0.5s (unchanged) |
| LLM agent calls (6 sequential) | ~60-90s | ~15-20s (parallel) |
| Summary generation | ~10-15s | ~8-10s (reduced prompt) |
| RAG indexing | ~1-2s | ~1-2s (unchanged) |
| **Total review** | **~75-110s** | **~25-35s** |

### 6. Prompt Audit
Audit every prompt in `backend/services/review_prompts.py` and `backend/services/review_service.py`.  
Identify and fix:
- Prompts that encourage verbose output (add explicit brevity instructions)
- Prompts sending entire files when only relevant sections needed
- Missing structured output enforcement
- Agents duplicating each other's scope

### 7. Shared Repository Intelligence Layer
Determine if code review and docs generation should share a common analysis layer.
Current problem: `_parse_workspace()` in `backend/main.py` runs the same file parsing for both review and docs, separately. The RAG pipeline is re-indexed for each run independently.

Propose: a lightweight `RepositoryIntelligence` object that is computed once per job and passed to both `ReviewService` and `DocumentationService`.

### 8. Files That Need Changes
| File | Current Problem | Proposed Change | Priority |
|---|---|---|---|
| `backend/services/review_service.py` | Sequential LLM calls, no routing | LangGraph pipeline, parallel agents | P0 |
| `backend/services/nim_client.py` | New client per call, serial rate limiter | Persistent client, semaphore | P1 |
| `frontend/components/GraphView.tsx` | Manual layout, no zoom, ugly | D3 force-directed, full redesign | P1 |
| `frontend/components/ReviewResults.tsx` | Raw findings list | Add Code Explainer section | P1 |
| `backend/models/schemas.py` | Missing `file_summaries` field | Add new field | P2 |
| `agents/orchestrator.py` | Always runs all agents | Add routing/filtering | P2 |
| `backend/services/review_prompts.py` | Verbose prompts, no brevity | Tighter instructions, token budget | P2 |

---

## PART 3 — IMPLEMENTATION PLAN

Implement in these exact stages. Each stage must leave the system runnable.

### STAGE 1 — NIM Client & Latency Fixes (Backend, no LangGraph yet)
- **Files**: `backend/services/nim_client.py`, `backend/utils/settings.py`
- Persistent httpx client
- Semaphore-based concurrency (3 parallel)
- Timeout tuning (45s agent, 90s docs)
- Reduced max_tokens (1024 agent, 2048 summary)
- **Test**: Run a review and confirm it completes faster without timeout
- **Risk**: Low — drop-in improvement to existing client

### STAGE 2 — Prompt Optimization
- **Files**: `backend/services/review_prompts.py`, `backend/services/review_service.py`
- Add brevity instructions to all agent prompts
- Reduce snippet size in `_build_sample()` from 7000 to 2500 chars
- Add agent-specific file filtering
- Fast-path single-call review for small diffs
- **Test**: Verify findings quality not degraded, tokens used reduced
- **Risk**: Low-medium — monitor finding quality

### STAGE 3 — LangGraph Multi-Agent Pipeline
- **Files**: `backend/services/review_service.py`, new `backend/services/review_graph.py`
- Install `langgraph`, `langchain-core` (add to `requirements.txt`)
- Build `StateGraph` with nodes: preprocess → route → parallel_llm_agents → aggregate → escalate → summarize
- Replace `_qwen_review_pass` + `_summarize_findings` with LangGraph invocation
- Keep `ReviewOrchestrator.run()` as the preprocessing node (unchanged)
- Agent routing based on file types and diff size
- **Test**: Full review run produces same or better findings in less time
- **Risk**: Medium — test thoroughly, keep old code path behind a feature flag initially

### STAGE 4 — Code Explainer UI
- **Files**: `frontend/components/ReviewResults.tsx`, new `frontend/components/CodeExplainer.tsx`, `backend/models/schemas.py`
- Add `file_summaries` to `ReviewResponse`
- Generate file summaries in backend (batched, parallel with agent pass)
- Build Code Explainer component with expandable findings
- Health score card at top
- **Test**: Visual review, check all persona types render correctly
- **Risk**: Low — purely additive UI change

### STAGE 5 — Graph Visualization Redesign
- **Files**: `frontend/components/GraphView.tsx`, `frontend/components/GraphPanel.tsx`, `frontend/app/dashboard/page.tsx`
- Install `d3` (`npm install d3 @types/d3`)
- Rewrite `GraphView.tsx` with D3 force-directed layout
- Color coding by group, glow effects, zoom/pan
- Slide-in info panel on node click
- Controls bar (zoom, reset, hotspot focus, group filters)
- Remove manual expand toggles
- **Test**: Generate docs for demo repo and verify graph auto-layouts correctly
- **Risk**: Medium — visual regression testing needed

### STAGE 6 — Integration & Polish
- Wire all stages together
- Verify GitHub webhook flow still works end-to-end
- Check Render deployment compatibility
- Final performance pass
- Update `README.md` with new architecture
- **Risk**: Low — all pieces already validated individually

---

## PART 4 — DELIVERABLE FORMAT

For each stage:
1. Show which files were changed and why
2. Show the key code changes (not every line — focus on the important diffs)
3. Explain what improved and what the measurable difference is
4. List any new dependencies added and why they are justified
5. Confirm the system still runs (`uvicorn backend.main:app` still starts, `npm run dev` still starts)

After ALL stages are complete:
- Provide a final architecture diagram (text-based)
- Provide a before/after latency comparison
- Confirm all 5 improvements from Part 1 are implemented
- List the top 5 highest-impact changes delivered

---

## IMPORTANT CONSTRAINTS

1. **Do not break what works.** Every stage must be independently deployable.
2. **Do not add packages without justification.** Each new dependency must solve a concrete problem.
3. **Do not send entire repositories to LLMs.** Always sample and filter first.
4. **Do not use LangChain for HTTP calls.** The existing `NIMClient` is well-built — use it.
5. **Do not redesign the FastAPI routing, job system, or GitHub integration.** These work correctly.
6. **Do not touch `frontend/app/page.tsx`** (the landing page).
7. **Preserve all environment variable names** — they are configured in production (Render + Vercel).
8. **The system must be runnable locally** with `uvicorn backend.main:app --reload` + `npm run dev` after each stage.
9. **Do not expose or print secrets** from `.env` files or environment variables.
10. **Match the existing design language**: mint green (#A7EF9E), dark backgrounds (#050d05), JetBrains Mono for code, Space Grotesk for prose.

---

## REPOSITORY STRUCTURE FOR REFERENCE

```
Hack_Genesis_hackathon/
├── backend/
│   ├── main.py                    ← FastAPI app, all routes, job system
│   ├── models/schemas.py          ← Pydantic models
│   ├── services/
│   │   ├── review_service.py      ← Main review pipeline (PRIMARY TARGET)
│   │   ├── doc_service.py         ← Docs generation pipeline
│   │   ├── nim_client.py          ← NVIDIA NIM HTTP client (PRIMARY TARGET)
│   │   ├── review_prompts.py      ← All LLM prompts (PRIMARY TARGET)
│   │   ├── ingestion.py           ← ZIP/URL → workspace
│   │   ├── persona.py             ← Persona modifiers
│   │   ├── structure_service.py   ← Code structure analysis
│   │   ├── state_store.py         ← State management
│   │   ├── token_crypto.py        ← PAT encryption
│   │   └── github_app_auth.py     ← GitHub App JWT
│   ├── utils/settings.py          ← All env var settings
│   └── requirements.txt
├── agents/
│   ├── orchestrator.py            ← Runs all 6 agents (keep, add routing)
│   ├── base_agent.py              ← AgentFinding dataclass
│   ├── bug_agent.py
│   ├── security_agent.py
│   ├── performance_agent.py
│   ├── readability_agent.py
│   ├── architecture_agent.py
│   └── accessibility_agent.py
├── rag/
│   ├── rag_pipeline.py
│   ├── chunker.py
│   ├── embedder.py
│   └── vector_store.py
├── docs/
│   ├── parser.py
│   ├── repo_loader.py
│   ├── readme_generator.py
│   ├── graph_builder.py
│   └── rot_detector.py
├── github/
│   ├── webhook.py
│   ├── diff_fetcher.py
│   ├── pr_handler.py
│   └── commenter.py
├── frontend/
│   ├── app/
│   │   ├── page.tsx               ← Landing page (DO NOT TOUCH)
│   │   ├── layout.tsx
│   │   ├── globals.css            ← Design tokens, all CSS vars
│   │   ├── dashboard/page.tsx     ← Main dashboard
│   │   └── components/
│   │       └── FaultyTerminal     ← WebGL terminal background
│   ├── components/
│   │   ├── ReviewResults.tsx      ← Review findings UI (PRIMARY TARGET)
│   │   ├── DocsResults.tsx        ← Docs output UI
│   │   ├── GraphView.tsx          ← Graph visualization (PRIMARY TARGET)
│   │   ├── GraphPanel.tsx         ← Graph panel wrapper (PRIMARY TARGET)
│   │   └── TreeView.tsx           ← File tree view
│   ├── lib/
│   │   ├── api.ts                 ← All API calls
│   │   └── types.ts               ← TypeScript types
│   └── src/
│       ├── components/
│       │   ├── GraphView.tsx
│       │   └── TreeView.tsx
│       └── utils/graphAdapter.ts  ← Graph data transformation
└── data/workspaces/               ← Temp extracted repos
```

---

## START HERE

Begin with the engineering report (Part 2), then proceed through the implementation stages (Part 3) in order. Do not skip stages. Do not implement Stage 3 before Stage 1 and 2 are complete and verified.

After completing all stages, confirm all 5 improvements from Part 1 are fully implemented and the system runs end-to-end.
