# Task: Implement 3 Separate NIM API Keys for 3 Models to Eliminate Timeout Congestion

## Background & Problem

This is a Python/FastAPI backend deployed on Render. It calls NVIDIA NIM (integrate.api.nvidia.com)
for AI code review. Currently there is **one shared NIMClient** with one API key. All LLM calls
share the same rate limiter and concurrency semaphore.

The problem: during a review job, up to 8 LLM calls fire concurrently (5-6 agent calls +
structure analysis + file summaries). They all hit the same API key quota simultaneously,
causing:
- `503 ResourceExhausted` (worker limit exceeded)
- `NIM timeout` at 45s (calls queue behind each other, burning the deadline)
- Retries with backoff (4-8s wasted per failed call)

## Desired Solution

Use **3 separate NVIDIA NIM API keys** — one per model role. Each key has its own independent
quota and rate limit, so the 3 model roles never compete with each other.

### The 3 Model Roles

| Role | Env var (model) | Env var (API key) | Used for |
|---|---|---|---|
| **Review** | `NIM_MODEL_QWEN_REVIEW` | `NIM_API_KEY_REVIEW` | 5-6 parallel agent calls |
| **Docs** | `NIM_MODEL_QWEN_DOCS` | `NIM_API_KEY_DOCS` | File summaries + README/docstrings |
| **Neotron** | `NIM_MODEL_NEOTRON` | `NIM_API_KEY_NEOTRON` | Structure analysis + escalated summary |

Fallback rule: if `NIM_API_KEY_REVIEW` is not set, fall back to `NIM_API_KEY`. Same for
`NIM_API_KEY_DOCS` and `NIM_API_KEY_NEOTRON`. This preserves backward compatibility —
existing deployments with only `NIM_API_KEY` must keep working unchanged.

## Codebase Architecture (read this carefully before making changes)

### File: `backend/services/nim_client.py`

Contains:
- `NIMClient` class — async httpx client with rate pacer and concurrency semaphore
- `NIMClient.__init__` currently reads `settings.nim_api_key` and `settings.nim_base_url`
- `NIMClient.chat(model, system_prompt, user_prompt, ...)` — the only LLM call method
- `RatePacer` class — per-client RPM limiter (do NOT touch this)
- `get_nim_client() -> NIMClient` — returns a single process-wide shared instance stored in `_shared_client`

### File: `backend/utils/settings.py`

A frozen `@dataclass` called `Settings`. Add 3 new fields:
```python
nim_api_key_review: str = os.getenv("NIM_API_KEY_REVIEW", "")
nim_api_key_docs: str = os.getenv("NIM_API_KEY_DOCS", "")
nim_api_key_neotron: str = os.getenv("NIM_API_KEY_NEOTRON", "")
```
These are optional. When blank, the callers fall back to `settings.nim_api_key`.

### File: `backend/services/review_service.py`

- `ReviewService.__init__` calls `self.nim = get_nim_client()` (line 35)
- `run_agent(agent, parsed_files, persona)` calls `self.nim.chat(model=settings.nim_model_qwen_review, ...)`
- `quick_review(...)` calls `self.nim.chat(model=settings.nim_model_qwen_review, ...)`
- `generate_file_summaries(...)` calls `self.nim.chat(model=settings.nim_model_qwen_docs, ...)`
- `generate_summary(...)` calls `self.nim.chat(model=settings.nim_model_qwen_review or neotron, ...)`

### File: `backend/services/doc_service.py`

- `DocumentationService.__init__` calls `self.nim = get_nim_client()` (line 20)
- Uses `settings.nim_model_qwen_docs` for all calls

### File: `backend/services/structure_service.py`

- `StructureService.__init__` calls `self.nim = get_nim_client()` (line 12)
- Uses `settings.nim_model_neotron` for all calls

### File: `backend/main.py`

- Line 29: `from backend.services.nim_client import get_nim_client`
- Line 103: `await get_nim_client().aclose()` — shutdown hook, must close ALL clients

## Exact Changes Required

### 1. `backend/utils/settings.py`

Add 3 new fields to the `Settings` dataclass after `nim_api_key`:
```python
nim_api_key_review: str = os.getenv("NIM_API_KEY_REVIEW", "")
nim_api_key_docs: str = os.getenv("NIM_API_KEY_DOCS", "")
nim_api_key_neotron: str = os.getenv("NIM_API_KEY_NEOTRON", "")
```

---

### 2. `backend/services/nim_client.py`

**Change `NIMClient.__init__`** to accept an optional `api_key` parameter:
```python
def __init__(self, api_key: str | None = None) -> None:
    base = settings.nim_base_url.rstrip("/")
    if base.endswith("/v1"):
        base = base[:-3]
    self.base_url = base
    # Use provided key, fall back to the global NIM_API_KEY
    self.api_key = api_key or settings.nim_api_key
    self._pacer = RatePacer(settings.nim_rate_limit_rpm)
    self._client: httpx.AsyncClient | None = None
    self._semaphore: asyncio.Semaphore | None = None
    self._client_lock: asyncio.Lock | None = None
```

**Replace the global singleton** at the bottom of the file with 3 named singletons + a
convenience getter that preserves backward compat:

```python
# Three dedicated clients — one per API-key / rate-limit domain.
# Callers that do not need a specific role can still call get_nim_client()
# and will receive the review client (the most-used one).
_client_review: NIMClient | None = None
_client_docs:   NIMClient | None = None
_client_neotron: NIMClient | None = None


def _resolve_key(role_key: str) -> str:
    """Return role-specific key if set, otherwise fall back to the shared key."""
    return role_key or settings.nim_api_key


def get_nim_client_review() -> NIMClient:
    global _client_review
    if _client_review is None:
        _client_review = NIMClient(api_key=_resolve_key(settings.nim_api_key_review))
    return _client_review


def get_nim_client_docs() -> NIMClient:
    global _client_docs
    if _client_docs is None:
        _client_docs = NIMClient(api_key=_resolve_key(settings.nim_api_key_docs))
    return _client_docs


def get_nim_client_neotron() -> NIMClient:
    global _client_neotron
    if _client_neotron is None:
        _client_neotron = NIMClient(api_key=_resolve_key(settings.nim_api_key_neotron))
    return _client_neotron


def get_nim_client() -> NIMClient:
    """Backward-compatible alias → returns the review client."""
    return get_nim_client_review()


async def aclose_all_nim_clients() -> None:
    """Close all three connection pools. Wire this to FastAPI shutdown."""
    for client in [_client_review, _client_docs, _client_neotron]:
        if client is not None and not client._client_closed():
            await client.aclose()
```

Note: add a helper `_client_closed(self) -> bool` on `NIMClient`:
```python
def _client_closed(self) -> bool:
    return self._client is None or self._client.is_closed
```

---

### 3. `backend/services/review_service.py`

Change `ReviewService.__init__`:
```python
from backend.services.nim_client import get_nim_client_review, get_nim_client_docs

class ReviewService:
    def __init__(self, rag: RAGPipeline) -> None:
        self.rag = rag
        self.orchestrator = ReviewOrchestrator()
        self.nim = get_nim_client_review()       # agents + quick review
        self.nim_docs = get_nim_client_docs()    # file summaries
        self.structure = StructureService()
```

Then update the one call that uses `nim_docs`:
- `generate_file_summaries` → change `self.nim.chat(...)` to `self.nim_docs.chat(...)`

All agent calls and `quick_review` stay on `self.nim` (review key). ✅

---

### 4. `backend/services/doc_service.py`

```python
from backend.services.nim_client import get_nim_client_docs

class DocumentationService:
    def __init__(self, rag: RAGPipeline) -> None:
        self.rag = rag
        self.nim = get_nim_client_docs()   # was: get_nim_client()
```

---

### 5. `backend/services/structure_service.py`

```python
from backend.services.nim_client import get_nim_client_neotron

class StructureService:
    def __init__(self) -> None:
        self.nim = get_nim_client_neotron()   # was: get_nim_client()
```

---

### 6. `backend/main.py`

In the shutdown handler (currently `await get_nim_client().aclose()`), replace with:
```python
from backend.services.nim_client import aclose_all_nim_clients

@app.on_event("shutdown")
async def on_shutdown() -> None:
    await aclose_all_nim_clients()
    await redis_client.aclose()
```

Also update the startup log to show all 3 keys' availability:
```python
logger.info(
    "Server started | nim_enabled=%s review_key=%s docs_key=%s neotron_key=%s",
    bool(settings.nim_api_key or settings.nim_api_key_review),
    bool(settings.nim_api_key_review),
    bool(settings.nim_api_key_docs),
    bool(settings.nim_api_key_neotron),
)
```

---

## New Environment Variables (add to Render dashboard)

```bash
NIM_API_KEY_REVIEW=nvapi-<key-1>      # used for all 5-6 parallel agent calls
NIM_API_KEY_DOCS=nvapi-<key-2>        # used for README, docstrings, file summaries
NIM_API_KEY_NEOTRON=nvapi-<key-3>     # used for structure analysis + escalated summary
NIM_API_KEY=nvapi-<any>               # legacy fallback if role keys are absent

# Also set these timeouts (models are 32b-70b, need headroom):
NIM_AGENT_TIMEOUT_SECONDS=90
NIM_DOCS_TIMEOUT_SECONDS=120
NIM_MAX_CONCURRENCY=5                 # can increase now each client has its own quota
NIM_RATE_LIMIT_RPM=40                 # per-client, so effective total = 120 RPM
```

---

## Constraints & Rules

### ⛔ SURGICAL EDITS ONLY — Do NOT change anything not listed in "Exact Changes Required"

This is the most important rule. The codebase is production-deployed. Every function,
method, class, and file NOT explicitly mentioned below must remain completely untouched —
same logic, same signatures, same return types, same variable names, same log messages.

Specifically, you MUST NOT change any of the following:

**In `nim_client.py`:**
- `RatePacer` class — do not touch any method or attribute
- `NIMClient.chat()` method — do not change its signature, logic, retry loop, backoff, or logs
- `NIMClient.aclose()` method — do not change
- `NIMClient._get_client()` — do not change
- `NIMClient._get_semaphore()` — do not change
- `CALL_PROFILES` dict — do not change
- `CallProfile` dataclass — do not change
- `_DEFAULT_PROFILE` — do not change

**In `review_service.py`:**
- `run_agent()` method body — do not change (only `self.nim` reference stays, which is
  already correct after the `__init__` change)
- `quick_review()` method body — do not change
- `generate_summary()` method body — do not change
- `review()` method — do not change
- `review_pr_fast()` method — do not change
- `_coerce_findings()` — do not change
- `_dedupe_findings()` — do not change
- `_apply_persona()` — do not change
- `_fallback_summary()` — do not change
- `_review_direct()` — do not change

**In `doc_service.py`:**
- All methods other than `__init__` — do not change
- The only change is replacing `get_nim_client()` with `get_nim_client_docs()` in `__init__`

**In `structure_service.py`:**
- All methods other than `__init__` — do not change
- The only change is replacing `get_nim_client()` with `get_nim_client_neotron()` in `__init__`

**In `main.py`:**
- All routes, middleware, startup logic, job workers, Redis helpers — do not change
- The only changes are: the shutdown hook and the startup log line

**Files you must NOT touch at all:**
- `review_graph.py` — zero changes
- `review_prompts.py` — zero changes
- `review_routing.py` — zero changes
- `persona.py` — zero changes
- `ingestion.py` — zero changes
- `github/commenter.py` — zero changes
- `github/diff_fetcher.py` — zero changes
- `github/pr_handler.py` — zero changes
- `github/webhook.py` — zero changes
- Any file in `agents/` — zero changes
- Any file in `rag/` — zero changes
- Any file in `docs/` — zero changes
- `models/schemas.py` — zero changes

### Additional rules

- **Do NOT add any new dependencies** — only stdlib + existing packages.
- **Do NOT reformat, reorder, or restyle** any code that is not being functionally changed.
  No black/isort/whitespace changes on untouched lines.
- **Do NOT rename any existing variables, parameters, or functions.** Only add new ones.
- **Preserve all existing log messages exactly** — only add new ones.
- **Do NOT add type: ignore comments** unless the existing code already uses them.

---

## Verification

After the change, a single review job should produce logs like:
```
NIM client initialised | max_concurrency=5 rpm=40   # appears 3 times, one per client
NIM request started | model=qwen/qwen2.5-coder-32b-instruct kind=agent attempt=1/3
NIM request started | model=qwen/qwen2.5-coder-32b-instruct kind=structure attempt=1/3
NIM request started | model=meta/llama-3.3-70b-instruct kind=summary attempt=1/3
```

The `kind=agent` and `kind=structure` calls should no longer queue behind each other
because they now use different API keys with independent concurrency semaphores and
rate limiters.

A deployment with only the old `NIM_API_KEY` set (no role-specific keys) must behave
identically to how it did before this change — no errors, no degraded functionality.


---

## Verification

After the change, a single review job should produce logs like:
```
NIM client initialised | max_concurrency=5 rpm=40   # appears 3 times, one per client
NIM request started | model=qwen/qwen2.5-coder-32b-instruct kind=agent attempt=1/3
NIM request started | model=qwen/qwen2.5-coder-32b-instruct kind=structure attempt=1/3
NIM request started | model=meta/llama-3.3-70b-instruct kind=summary attempt=1/3
```

The `kind=agent` and `kind=structure` calls should no longer queue behind each other
because they now use different API keys with independent concurrency semaphores and
rate limiters.
