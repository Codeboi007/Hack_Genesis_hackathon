# AI Developer Platform

Full-stack SaaS-style platform for:
- AI Code Reviewer
- AI Documentation Generator

## Stack
- Frontend: Next.js (App Router)
- Backend: FastAPI
- Storage: in-memory + local temp files (no external DB)
- AI: NVIDIA NIM APIs (Neotron + Qwen)

## Project Structure
- `frontend/` Next.js dashboard UI
- `backend/` FastAPI API service
- `agents/` code review agents
- `rag/` in-memory RAG pipeline
- `docs/` parser + docs generation
- `github/` webhook + PR diff flow

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
- `GITHUB_WEBHOOK_SECRET=<random-strong-secret>`
- `GITHUB_APP_ID=<from GitHub App settings page>`
- `GITHUB_PRIVATE_KEY=<contents of the .pem private key>`
- `GITHUB_TOKEN=<optional fallback token, can be empty if App auth is configured>`
- `NIM_API_KEY=<nvidia-key>`
- `NIM_BASE_URL=https://integrate.api.nvidia.com`
- `NIM_MODEL_NEOTRON=<model-id>`
- `NIM_MODEL_QWEN_DOCS=<model-id>`
- `NIM_MODEL_QWEN_REVIEW=<model-id>`

Health check after deploy:
- `https://<your-backend>.onrender.com/api/health`

## 4) Deploy Frontend on Vercel

In Vercel, import repo and set project root to `frontend/`.

Add env var in Vercel:
- `NEXT_PUBLIC_API_BASE_URL=https://<your-backend>.onrender.com`

Redeploy frontend after setting env vars.

## 5) GitHub App Setup (Organization Repository)

This project supports GitHub App installation-token auth for PR diff fetching.

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
- `POST /api/review/repo`
- `POST /api/review/upload`
- `POST /api/docs/repo`
- `POST /api/docs/upload`
- `POST /api/github/webhook`
- `GET /api/health`

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
