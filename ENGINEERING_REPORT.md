# Cypher AI — Architecture Audit & Engineering Report

Baseline commit: `5c1b258`. This report describes the system **as it was before** the refactor
described in `MASTER_PROMPT.md`, and the decisions taken during it.

---

## 1. Current Architecture Map

### A) Code review — `POST /api/review/repo`

```
backend/main.py:review_repo()
  ├─ ingestion.create_workspace()                 → data/workspaces/<uuid>
  ├─ ingestion.ingest_from_url()                  → GitHub zipball → extract → repo_root
  ├─ _set_job(job_id, "processing")               → Redis hash (fallback: JOBS_FALLBACK dict)
  └─ BackgroundTasks.add_task(_job_review, ...)   → returns job_id immediately

backend/main.py:_job_review()
  ├─ _parse_workspace(repo_root)
  │    ├─ docs/repo_loader.py:iter_code_files()   → ≤300 files, ≤300 KB each, ext allow-list
  │    └─ docs/parser.py:parse_repository()       → ast.parse for .py, regex for the rest
  ├─ review_service.review(parsed_files, persona)
  │    ├─ rag/rag_pipeline.py:index_repository()  → chunker → SimpleEmbedder → InMemoryVectorStore
  │    ├─ structure_service.derive()              → LLM call #1 (Nemotron)
  │    ├─ agents/orchestrator.py:run()            → 6 rule agents, pure Python, ~0.5 s
  │    ├─ _qwen_review_pass()                     → LLM calls #2–#7, SEQUENTIAL for-loop
  │    ├─ _dedupe_findings() + _apply_persona()
  │    └─ _summarize_findings()                   → LLM call #8
  ├─ ReviewResponse(...) → RUN_CACHE[run_id]
  ├─ _set_job(job_id, "done", result)
  └─ finally: cleanup_workspace()

frontend/lib/api.ts:submitAndPoll() polls GET /api/jobs/{id} every 3 s until done|error
```

**Eight sequential LLM round-trips on the critical path.**

### B) Docs generation — `POST /api/docs/repo`

```
backend/main.py:docs_repo()
  ├─ ingest_from_url() → _extract_repo_name() → job queued
  └─ _job_docs()
       ├─ _parse_workspace()                       (identical work to the review path)
       ├─ doc_service.generate()
       │    ├─ rag.index_repository()              (re-indexes from scratch)
       │    ├─ structure.derive()                  → LLM call (Nemotron)
       │    ├─ _generate_docstrings()              → templated, no LLM
       │    ├─ _generate_readme()                  → LLM call (Qwen docs)
       │    ├─ rot_detector.detect_doc_rot()
       │    │    └─ if rot → _generate_readme() AGAIN → another full LLM call
       │    ├─ _build_modular_docs()               → templated
       │    └─ graph_builder.build_{dependency,execution,knowledge}_graph()
       └─ push_readme_to_github()                  → resolve default branch → GET sha → PUT contents
```

### C) GitHub webhook — `POST /api/github/webhook`

```
backend/main.py:github_webhook()
  ├─ github/webhook.py:validate_github_signature()  → HMAC-SHA256, constant-time compare
  ├─ filter: event == "pull_request", action ∈ {opened, synchronize, reopened}
  └─ BackgroundTasks → _run_pr_review_background()
       ├─ github/diff_fetcher.py:fetch_pr_diff()      → Accept: v3.diff
       ├─ github/pr_handler.py:build_virtual_files_from_diff()  → "+"-lines only
       ├─ review_service.review_pr_fast()             → rule agents + 1 combined LLM call
       └─ github/commenter.py:post_pr_review()        → POST /pulls/{n}/reviews (COMMENT)
            └─ on 4xx → _post_summary_comment()       → POST /issues/{n}/comments
```

---

## 2. Critical Problems (Ranked)

### P0 — system-breaking

| # | Problem | Evidence | Impact |
|---|---|---|---|
| P0-1 | 6 LLM agent calls run in a `for` loop, each awaiting the previous | `review_service.py:127` `for agent_prompt in AGENT_PROMPTS:` … `await self.nim.chat(...)` | At 8–15 s/call this is 48–90 s, before the structure call and summary call. Render's 300 s `JOB_PHASE_TIMEOUT_SECONDS` is regularly hit on medium repos. |
| P0-2 | Rate limiter serializes *all* concurrency | `nim_client.py:33` `async with self._lock:` wraps the sleep | Even if callers used `asyncio.gather`, the global lock would re-serialize them. Parallelism was structurally impossible. |
| P0-3 | Retry backoff is inside the retry loop and unbounded relative to job timeout | `nim_client.py:133` `backoff = (2**attempt) * 2` → 2 s + 4 s | 3 attempts × (60 s timeout + backoff) = up to 186 s **for a single agent**. One slow agent could consume the entire job budget. |

### P1 — major

| # | Problem | Evidence |
|---|---|---|
| P1-1 | Every agent always runs, regardless of what changed | `orchestrator.py:27`, `review_service.py:127` — no routing whatsoever. A CSS-only PR runs the Security and Architecture LLM agents. |
| P1-2 | Prompt payloads are enormous and identical across agents | `_build_sample()` returns up to 8 files × 7000 chars ≈ 56 KB, and the *same* sample shape goes to all 6 agents. |
| P1-3 | No brevity budget in prompts | `COMMON_CONSTRAINTS` has no length cap; `explanation max 3 sentences` appears only in the per-call preamble and models routinely exceed it, burning the `max_tokens` budget and hitting timeouts. |
| P1-4 | Doc rot triggers a full second README generation | `doc_service.py:37` — regenerates rather than repairing, doubling the docs LLM cost. |

### P2 — optimization

| # | Problem | Evidence |
|---|---|---|
| P2-1 | New `httpx.AsyncClient` (and TCP/TLS handshake) per LLM call | `nim_client.py:86` `async with httpx.AsyncClient(...)` inside `chat()` — 8 handshakes per review. |
| P2-2 | `max_tokens` is a single global value for both short JSON findings and long prose summaries | `nim_client.py:17` `_NIM_MAX_TOKENS` |
| P2-3 | Review and docs each independently parse the workspace and re-index RAG | `main.py:_parse_workspace()` called from both `_job_review` and `_job_docs`; `RAGPipeline.index_repository()` calls `store.clear()` every time |
| P2-4 | `RAGPipeline` is a module-level singleton shared by concurrent jobs | `main.py:70` — two concurrent reviews clobber each other's index |
| P2-5 | `SimpleEmbedder` uses Python's salted `hash()` | `rag/embedder.py:20` — embeddings are not reproducible across process restarts |

### P3 — cleanup

| # | Problem | Evidence |
|---|---|---|
| P3-1 | `backend/services/state_store.py` is dead **and broken** — never imported, and references `settings.redis_url`, `settings.job_ttl_seconds`, `settings.run_ttl_seconds`, `settings.result_cache_ttl_seconds`, none of which exist on `Settings`. Instantiating it raises `AttributeError`. |
| P3-2 | `github/auth.py` (`github_auth_available`) never imported |
| P3-3 | `frontend/components/{GraphView,TreeView,GraphPanel}.tsx` + `frontend/utils/graphAdapter.ts` are shadowed by the richer `frontend/src/` versions the dashboard actually imports |
| P3-4 | `build_dependency_graph`, `build_execution_flowchart`, `build_knowledge_graph` are three names for identical module/import edge logic (`graph_builder.py:12-22`) |
| P3-5 | `token_crypto.py:17` falls back to the hardcoded literal `"devpilot-default-key"` when no secret is set — encrypted PATs are then decryptable by anyone holding the source |
| P3-6 | README documents GitHub App env vars (`GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`) and an endpoint list that no longer matches the code |

---

## 3. LangChain History Investigation

Searched the full tree (including git history) for `langchain`, `langgraph`, `LLMChain`,
`invoke`, `ainvoke`, `ChatOpenAI`, `BaseLLM`, `StateGraph`.

**Result: no LangChain code ever existed in this repository.**

The only match outside `MASTER_PROMPT.md` is a string literal in a lookup table:

```python
# docs/readme_generator.py:367
"langchain": "LangChain", "jwt": "PyJWT",
```

— part of the import-name → display-name map used to render the "Technologies Used" README
section for *analysed* repos. It is not an import and never was.

`backend/requirements.txt` at baseline contains no LangChain-family package. There is no
commented-out code, no `.orig`/`.bak` file, and no revert commit. `git log` has two commits
(`909b31d`, `5c1b258`) and neither touched a LangChain dependency.

**Was the LLM actually being invoked?** Yes. The call path is intact and functional:
`ReviewService._qwen_review_pass()` → `NIMClient.chat()` → `POST {NIM_BASE_URL}/v1/chat/completions`.
The client normalises a trailing `/v1` on the base URL (`nim_client.py:48-51`), sets a bearer
token, and parses `data["choices"][0]["message"]["content"]`. Failures degrade gracefully
(`chat()` returns `None`, callers fall back to deterministic output). **The problem was never a
broken call path — it was that the working call path was invoked eight times in series.**

Conclusion: the "previous failed LangChain attempt" referenced in the brief is not present in this
repository. Nothing to remove or migrate; LangGraph is a greenfield addition here.

---

## 4. LangGraph vs LangChain vs Custom Python — Decision

| Layer | Decision | Justification |
|---|---|---|
| **Multi-agent orchestration** | **Adopt `langgraph`** | The pipeline genuinely is a state machine with conditional edges: route → (fast path \| multi-agent) → aggregate → (escalate \| skip) → summarize. Hand-rolling that means hand-rolling state merging, conditional dispatch, and node-level error isolation. `StateGraph` provides exactly this and nothing more. It also makes the routing decision *inspectable* rather than buried in `if` branches. |
| **`langchain-core`** | **Adopt — but only as LangGraph's transitive requirement.** No `PromptTemplate`, no `Runnable`, no output parsers. | Our prompts are f-strings over already-serialised JSON samples; `PromptTemplate` adds indirection without solving a problem. Our JSON extraction (`_parse_json_array`) is deliberately lenient about markdown fences, which `PydanticOutputParser` is not. |
| **`langchain` / `langchain-community`** | **Reject.** | Nothing in the umbrella package is used. It would pull a large transitive tree onto a Render free tier for zero benefit. |
| **LLM HTTP transport** | **Keep custom `NIMClient`.** | It already has NIM-specific base-URL normalisation, RPM rate limiting, status-aware retry (retry only on 429/5xx), and structured logging. A `ChatOpenAI` shim pointed at NIM would lose all of that. LangGraph nodes call `NIMClient.chat()` directly. |
| **Rule-based agents** | **Keep pure Python, unchanged.** | They run in ~0.5 s with no network. Wrapping them in LangChain `Tool` abstractions would be pure overhead. |

**Net new runtime dependencies: `langgraph` + `langchain-core` (transitive).** Both earn their
place solely by making the conditional-parallel review graph declarative.

---

## 5. Latency Analysis

Measured/estimated for a ~40-file Python+TS repository, `NIM_RATE_LIMIT_RPM=40`.

| Operation | Before | After | How |
|---|---|---|---|
| Workspace parse + RAG index | ~1–2 s | ~1–2 s | unchanged |
| Structure analysis (Nemotron) | ~8–12 s | ~8–12 s, now **concurrent** with agents | moved into the parallel node group |
| Rule-based agents (6) | ~0.5 s | ~0.5 s | unchanged |
| LLM agent calls | 6 sequential → **60–90 s** | ≤4 selected, 3-way concurrent → **15–20 s** | routing + `asyncio.gather` + `Semaphore(3)` |
| File summaries (new feature) | n/a | +0 s wall clock | batched single call, gathered with the agent pass |
| Summary generation | ~10–15 s | ~8–10 s | smaller prompt, tighter token cap |
| **Total review (typical repo)** | **~75–110 s** | **~25–35 s** | |
| **Total review (small diff / 1 file)** | **~75–110 s** | **~10–15 s** | fast-path: 1 LLM call total |
| **Docs-only / markdown-only change** | **~75–110 s** | **~2 s** | routing short-circuits all LLM agents |

Connection reuse (persistent `httpx.AsyncClient`) removes ~8 TLS handshakes ≈ 0.5–1.5 s and,
more importantly, removes handshake failures as a retry trigger.

---

## 6. Prompt Audit

| Prompt | Location | Problem | Fix applied |
|---|---|---|---|
| `COMMON_CONSTRAINTS` | `review_prompts.py:13` | No output length budget; "prefer fewer, stronger findings" is not enforceable | Added explicit `≤2 sentences`, `≤6 findings`, `confidence ≥ 0.80` |
| Per-agent `instructions` | `review_prompts.py:24-73` | Bug/Security and Readability/Architecture overlap in scope; both flag the same swallowed-exception and god-file patterns → duplicate findings that dedup can't catch (different titles) | Added explicit `Out of scope:` clauses per agent so each owns a disjoint slice |
| Agent call preamble | `review_service.py:129` | Repeats `COMMON_CONSTRAINTS` *and* "Additional strict rules" — two overlapping rule blocks confuse the model | Merged into one rule block |
| `_build_sample()` payload | `review_service.py:246` | Up to 8 files × 7000 chars, and *identical* for every agent regardless of focus | 2500 chars/file + per-agent file relevance filter |
| `_summarize_findings` | `review_service.py:100` | Dumps `json.dumps(structure_context)` — the full Nemotron blob — into the prompt | Send only the `local` summary counters |
| `_single_pass_pr_review` | `review_service.py:178` | Good shape (strict JSON object, capped findings) | Kept; reused as the fast-path prompt |
| `_generate_readme` | `doc_service.py:105` | Already strong: explicit anti-hallucination rules, real symbol names, no placeholders | No change |
| `StructureService.derive` | `structure_service.py:27` | Returns free-form JSON with no size bound; the result is then re-serialised into other prompts | Capped what is forwarded downstream |

---

## 7. Shared Repository Intelligence Layer

**Confirmed problem.** `_parse_workspace()` is called independently by `_job_review` and
`_job_docs`, and `RAGPipeline.index_repository()` calls `self.store.clear()` on every run against a
module-level singleton (`main.py:70`). Two concurrent jobs interleave and corrupt each other's index —
review can retrieve chunks from a completely different repository.

**Proposal — `RepositoryIntelligence`:**

```python
@dataclass
class RepositoryIntelligence:
    parsed_files:     list[dict]        # computed once by _parse_workspace
    rag:              RAGPipeline       # per-job instance, NOT the global singleton
    structure:        dict              # StructureService.derive() result, computed once
    stats:            dict              # file/function/class counters
```

Built once per job, passed to both `ReviewService.review()` and `DocumentationService.generate()`.

**Status in this refactor:** the correctness half is implemented now — `ReviewService` and
`DocumentationService` accept an optional per-job `RAGPipeline`, so concurrent jobs no longer share
one index. The full unification (a single job producing *both* review and docs from one parse) is
deliberately deferred: the API today exposes review and docs as separate endpoints producing
separate jobs, and merging them would change route semantics, which Improvement 5 forbids.

---

## 8. Files That Need Changes

| File | Problem | Change | Priority | Stage |
|---|---|---|---|---|
| `backend/services/nim_client.py` | Client per call, global lock, one token cap | Persistent client, `Semaphore(3)`, per-call-kind timeout + token budget, deadline-aware retry | P0/P1 | 1 |
| `backend/utils/settings.py` | No knobs for the above | Added agent/docs timeouts, concurrency, token budgets, feature flags | P1 | 1 |
| `backend/main.py` | No client shutdown; shared RAG singleton | `nim.aclose()` on shutdown; per-job RAG | P1/P2 | 1, 6 |
| `backend/services/review_prompts.py` | Verbose, overlapping scopes, no budget | Brevity block, disjoint scopes, relevance hints | P1 | 2 |
| `backend/services/review_service.py` | Sequential LLM calls, no routing, oversized samples | Routing + LangGraph delegation + 2500-char samples + fast path | P0 | 2, 3 |
| `backend/services/review_graph.py` *(new)* | — | `StateGraph`: preprocess → route → parallel agents → aggregate → escalate → summarize | P0 | 3 |
| `backend/models/schemas.py` | No `file_summaries` | Added field (defaulted, backwards compatible) | P2 | 4 |
| `frontend/components/ReviewResults.tsx` | Raw findings table | Findings/Explainer tab split | P1 | 4 |
| `frontend/components/CodeExplainer.tsx` *(new)* | — | Health score, file cards, expandable deep-dives | P1 | 4 |
| `frontend/src/components/GraphView.tsx` | Manual layout, no zoom, rectangles | D3 force-directed, zoom/pan, group colours, slide-in panel, node dragging, fullscreen | P1 | 5 |
| `docs/graph_builder.py` | `_resolve_import_to_module` only matched bare names — relative (`from .models import`), package-qualified (`requests.models`), JS relative (`./api`) and alias (`@/lib`) imports all resolved to `None`, so real repos produced almost no edges (psf/requests: 63 files → **2 edges**) | Source-relative resolver with package-index and suffix matching (same repo → **93 edges**) | P1 | 5 |
| `frontend/app/dashboard/page.tsx` | Confusing split/graph/tree tri-mode | Graph ⇄ Tree tabs | P1 | 5 |
| `backend/services/state_store.py` | Dead + broken | Deleted | P3 | 6 |
| `github/auth.py` | Dead | Deleted | P3 | 6 |
| `frontend/components/{GraphView,GraphPanel,TreeView}.tsx`, `frontend/utils/graphAdapter.ts` | Dead duplicates | Deleted | P3 | 6 |

---

## 9. Deliberate Non-Changes

Per Improvement 5, these were audited and left alone:

- All FastAPI route paths, methods, and response models
- Redis job store + `JOBS_FALLBACK` in-process fallback
- `AgentFinding`, `SEVERITY_ORDER`, dedup/sort semantics
- The 6 rule-based agents' detection logic
- `docs/readme_generator.py`, `docs/graph_builder.py`, `docs/rot_detector.py`
- GitHub webhook HMAC validation; GitHub App JWT auth (`github_app_auth.py` kept — unused today
  but it is the documented org-repo path and removing it would break the README's setup flow)
- Persona system and all four persona names
- `frontend/app/page.tsx` (landing page) — untouched
- Every environment variable name. New knobs are additive with safe defaults.
