# AI Developer Platform (Cypher AI)

Full-stack SaaS-style platform for:
- AI Code Reviewer
- AI Documentation Generator

## Stack
- Frontend: Next.js (App Router) + D3 for dependency visualisation
- Backend: FastAPI, async background jobs, Redis job store (in-process fallback)
- Orchestration: LangGraph state machine for the multi-agent review pipeline
- Storage: in-memory + local temp files (no external DB)
- AI: NVIDIA NIM APIs (Nemotron + Qwen)

## Project Structure
- `frontend/` Next.js dashboard UI
- `backend/` FastAPI API service
- `agents/` rule-based code review agents (pure Python, no LLM)
- `rag/` in-memory RAG pipeline
- `docs/` parser + docs generation
- `github/` webhook + PR diff flow

See `ENGINEERING_REPORT.md` for the full architecture audit and the rationale behind
the current pipeline design.

## Review Pipeline Architecture

A review is a LangGraph `StateGraph` (`backend/services/review_graph.py`). LangGraph
handles orchestration only — every LLM request still goes through `NIMClient`
(`backend/services/nim_client.py`), which owns rate limiting, retries, backoff, and a
shared connection pool.

```
START
  │
  ▼
preprocess ──────► 6 rule-based agents + repository classification (no LLM, ~0.5s)
  │
  ▼
route ───────────► picks the strategy based on what actually changed
  │
  ├── "skip"   ───────────────────────────► aggregate     docs/markdown only: 0 LLM calls
  ├── "fast"   ──► quick_review ──────────► aggregate     small diff: 1 LLM call
  └── "agents" ──► parallel_agents ───────► aggregate     selected agents, CONCURRENT
  │                                                        (+ structure + file summaries)
  ▼
aggregate ───────► dedupe + confidence sort + persona voice
  │
  ▼
escalate ────────► strong model for synthesis if critical findings or large repo
  │
  ▼
summarize ───────► final summary
  │
  ▼
 END
```

**Agent routing rules** (`backend/services/review_routing.py`):

| Condition | Behaviour |
|---|---|
| Docs/markdown only | Skip all LLM agents |
| CSS/HTML/style only | Skip Bug, Security, Architecture agents |
| No UI files present | Skip Accessibility agent |
| Contains auth/crypto/SQL keywords | Always include Security agent |
| Single file, <3000 chars, or <50 lines | Single-call fast path instead of fan-out |
| More than 20 files | Sample the top 10 by complexity score |

Set `REVIEW_USE_LANGGRAPH=false` to fall back to the equivalent direct `asyncio.gather`
pipeline — same routing, same results, no LangGraph dependency on the hot path.

## 1) Local Run (Quick Start)

### Backend
```bash
python -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000
```

### Frontend
```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:3000`.

## 2) URL Mapping (Most Important)

After deployment you will have:
- Render backend URL: `https://<your-backend>.onrender.com`
- Vercel frontend URL: `https://<your-frontend>.vercel.app`

Use them in these exact places:

1. Put **Render backend URL** into frontend env:
- `NEXT_PUBLIC_API_BASE_URL=https://<your-backend>.onrender.com`

2. Put **Vercel frontend URL** into backend CORS env:
- `CORS_ORIGINS=https://<your-frontend>.vercel.app`

3. Put **Render webhook endpoint** into GitHub webhook URL:
- `https://<your-backend>.onrender.com/api/github/webhook`

## 3) Deploy Backend on Render

Create a Render Web Service from this repo.

Render settings:
- Runtime: `Python`
- Build Command: `pip install -r backend/requirements.txt`
- Start Command: `uvicorn backend.main:app --host 0.0.0.0 --port $PORT`
- Root Directory: repo root (leave blank)

Environment variables on Render:
- `CORS_ORIGINS=https://<your-frontend>.vercel.app`
- `KEEP_WORKSPACES=false` (recommended; temporary repo snapshots are auto-cleaned)
- `REDIS_URL=<redis connection string>` (optional; falls back to in-process job state)
- `GITHUB_WEBHOOK_SECRET=<random-strong-secret>`
- `GITHUB_REVIEW_TOKEN=<fine-grained PAT: Pull requests R/W, Issues R/W>`
- `GITHUB_DOCS_TOKEN=<fine-grained PAT: Contents R/W>`
- `TOKEN_ENCRYPTION_SECRET=<random-strong-secret>` (encrypts dashboard-submitted PATs)
- `NIM_API_KEY=<nvidia-key>`
- `NIM_BASE_URL=https://integrate.api.nvidia.com`
- `NIM_MODEL_NEOTRON=<model-id>`
- `NIM_MODEL_QWEN_DOCS=<model-id>`
- `NIM_MODEL_QWEN_REVIEW=<model-id>`

Optional performance/tuning variables (all have safe defaults):

| Variable | Default | Purpose |
|---|---|---|
| `NIM_MAX_CONCURRENCY` | `3` | Concurrent in-flight NIM requests |
| `NIM_RATE_LIMIT_RPM` | `40` | Requests-per-minute pacing |
| `NIM_AGENT_TIMEOUT_SECONDS` | `45` | Timeout for agent review calls |
| `NIM_DOCS_TIMEOUT_SECONDS` | `90` | Timeout for summary/docs generation |
| `NIM_MAX_TOKENS_AGENT` | `1024` | Token cap for JSON findings |
| `NIM_MAX_TOKENS_SUMMARY` | `2048` | Token cap for prose summaries |
| `REVIEW_USE_LANGGRAPH` | `true` | Toggle the LangGraph pipeline |
| `REVIEW_MAX_SNIPPET_CHARS` | `2500` | Per-file code sent to each agent |
| `REVIEW_FASTPATH_MAX_CHARS` | `3000` | Below this, use the single-call fast path |
| `REVIEW_MAX_LLM_FILES` | `10` | Max files sampled per agent |

> `TOKEN_ENCRYPTION_SECRET` has a hardcoded development fallback. Set it in production,
> or dashboard-submitted PATs are encrypted with a key that is public in the source.

Health check after deploy:
- `https://<your-backend>.onrender.com/api/health`

## 4) Deploy Frontend on Vercel

In Vercel, import repo and set project root to `frontend/`.

Add env var in Vercel:
- `NEXT_PUBLIC_API_BASE_URL=https://<your-backend>.onrender.com`

Redeploy frontend after setting env vars.

## 5) GitHub Setup

### Token model (what the running code actually uses)

The PR review and README push flows authenticate with two **fine-grained PATs**, not
with GitHub App installation tokens:

| Token | Env var | Required permissions | Used by |
|---|---|---|---|
| PR Review | `GITHUB_REVIEW_TOKEN` | Pull requests R/W, Issues R/W | `github/commenter.py`, `github/diff_fetcher.py` |
| Docs Push | `GITHUB_DOCS_TOKEN` | Contents R/W | `push_readme_to_github()` |

Users can also paste a PAT in the dashboard; it is validated by
`POST /api/github/verify-docs-token` and returned encrypted (Fernet) for one-time use.

`backend/services/github_app_auth.py` implements GitHub App JWT + installation-token
auth and is retained for the organization-App setup below, but the default PR flow uses
`GITHUB_REVIEW_TOKEN`.

### Webhook (required for automatic PR review)

Add a repository (or App) webhook:
- **Payload URL**: `https://<your-backend>.onrender.com/api/github/webhook`
- **Content type**: `application/json`
- **Secret**: the same value as `GITHUB_WEBHOOK_SECRET` on Render
- **Events**: `Pull requests` only

The backend validates the `X-Hub-Signature-256` HMAC and acts on `opened`,
`synchronize`, and `reopened` actions. Leaving `GITHUB_WEBHOOK_SECRET` blank skips
signature validation — do not do that in production.

### Optional: GitHub App for organization repositories

### A) Create or open your GitHub App
GitHub -> Organization Settings -> Developer settings -> GitHub Apps.

Set these fields in the App:
1. **Webhook URL**
   - `https://<your-backend>.onrender.com/api/github/webhook`
2. **Webhook secret**
   - set it to the same value you will put in `GITHUB_WEBHOOK_SECRET` on Render
3. **Permissions** (minimum for current flow)
   - Repository permissions -> `Pull requests: Read-only`
   - Repository permissions -> `Contents: Read-only`
   - Repository permissions -> `Metadata: Read-only` (usually always available)
4. **Subscribe to events**
   - `Pull request`

### B) Install the App on the organization repo
1. In the GitHub App page, click **Install App**.
2. Choose your organization.
3. Select the target repository (or all repos if you prefer).

### C) Copy values into Render env vars
From the GitHub App settings page:
1. Copy **App ID** -> set `GITHUB_APP_ID` on Render.
2. Generate/download a **Private key (.pem)**.
3. Put full private key content into `GITHUB_PRIVATE_KEY` on Render.
   - If needed, convert newlines to `\\n` when pasting into a single-line env field.
4. Set `GITHUB_WEBHOOK_SECRET` to the exact webhook secret configured in the App.

After saving env vars, redeploy backend.

### D) Verify
1. Open/update a PR in the installed org repo.
2. GitHub App sends webhook to Render backend.
3. Backend validates signature and exchanges App JWT for installation token.
4. Backend fetches PR diff and runs review agents.

## Core API Endpoints

All heavy endpoints are asynchronous: they return a `job_id` immediately, and the client
polls `GET /api/jobs/{job_id}` until `status` is `done` or `error`.

| Method | Path | Returns |
|---|---|---|
| `POST` | `/api/review/repo` | `JobStatus` — review from a GitHub URL |
| `POST` | `/api/review/upload` | `JobStatus` — review from a ZIP upload |
| `POST` | `/api/docs/repo` | `JobStatus` — docs from a GitHub URL |
| `POST` | `/api/docs/upload` | `JobStatus` — docs from a ZIP upload |
| `GET` | `/api/jobs/{job_id}` | `JobStatus` — poll for the result |
| `POST` | `/api/github/verify-docs-token` | Validates + encrypts a docs PAT |
| `POST` | `/api/github/webhook` | PR review webhook (HMAC-validated) |
| `GET` | `/api/health` | Liveness + cache/RAG counters |

## Common Mistakes
- Frontend can load but API calls fail:
  - `NEXT_PUBLIC_API_BASE_URL` is missing/wrong in Vercel.
- CORS errors in browser:
  - `CORS_ORIGINS` on Render does not match your Vercel URL.
  - Local frontend may run on a non-3000 port (e.g. `5173`, `5500`). Backend now allows `localhost/127.0.0.1` on any local port, but restart backend after pulling latest changes.
- GitHub webhook returns 403:
  - webhook secret in GitHub does not match `GITHUB_WEBHOOK_SECRET`.
- Webhook returns 502 on PR fetch:
  - GitHub App permissions are insufficient, App is not installed on that repo, or `GITHUB_APP_ID` / `GITHUB_PRIVATE_KEY` is invalid.

## Workspace Snapshot Behavior
- Default behavior: temporary extracted repositories are deleted after processing.
- If you explicitly want to keep them for debugging, set `KEEP_WORKSPACES=true`.
