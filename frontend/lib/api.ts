import {
  DocsResponse,
  Persona,
  ReviewResponse,
  TokenVerifyResponse,
} from "./types";

function getApiBase(): string {
  return process.env.NEXT_PUBLIC_API_BASE_URL?.trim().replace(/\/$/, "") ?? "";
}

function normalizeErrorMessage(raw: string): string {
  const msg = raw.trim();
  const lower = msg.toLowerCase();

  if (
    lower.includes("http 429") ||
    lower.includes("rate limit") ||
    lower.includes("quota")
  ) {
    return "NVIDIA model limit reached on Render. Please wait 1-2 minutes and retry, or use a smaller/faster model in backend env vars.";
  }

  if (lower.includes("failed to fetch") || lower.includes("networkerror")) {
    return "Unable to reach the backend API. Verify your Render backend is awake and NEXT_PUBLIC_API_BASE_URL points to the correct service URL.";
  }

  if (lower.includes("timed out") || lower.includes("timeout")) {
    return "Model request timed out on Render. Retry once, or switch to a faster model (for example qwen2.5-coder-7b) in backend env vars.";
  }

  if (lower.includes("internal server error")) {
    return "Backend failed while processing this request. Check Render logs for the matching request and retry.";
  }

  return msg || "Request failed";
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `Request failed (HTTP ${res.status})`;
    try {
      const ct = res.headers.get("content-type") ?? "";
      if (ct.includes("application/json")) {
        const json = await res.json();
        message = json?.detail ?? json?.message ?? JSON.stringify(json);
      } else {
        const text = await res.text();
        if (text) message = text;
      }
    } catch {
      // ignore parse errors
    }
    throw new Error(normalizeErrorMessage(message));
  }
  return res.json() as Promise<T>;
}

interface JobStatus {
  job_id: string;
  status: "queued" | "processing" | "done" | "error";
  message: string;
  result: unknown | null;
}

async function submitAndPoll<T>(
  submitFn: () => Promise<Response>,
  onProgress?: (msg: string) => void,
): Promise<T> {
  const submitRes = await submitFn();
  const job: JobStatus = await handleResponse<JobStatus>(submitRes);

  if (job.status === "done" && job.result) {
    return job.result as T;
  }
  if (job.status === "error") {
    throw new Error(normalizeErrorMessage(job.message || "Job failed"));
  }

  const pollIntervalMs = 3000;
  const jobId = job.job_id;

  while (true) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    const pollRes = await fetch(`${getApiBase()}/api/jobs/${jobId}`);
    const status: JobStatus = await handleResponse<JobStatus>(pollRes);

    if (onProgress) onProgress(status.message || status.status);

    if (status.status === "done" && status.result) {
      return status.result as T;
    }
    if (status.status === "error") {
      throw new Error(normalizeErrorMessage(status.message || "Job failed"));
    }
  }
}

export async function reviewFromRepo(
  repoUrl: string,
  persona: Persona,
  onProgress?: (msg: string) => void,
): Promise<ReviewResponse> {
  return submitAndPoll<ReviewResponse>(
    () =>
      fetch(`${getApiBase()}/api/review/repo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo_url: repoUrl, persona }),
      }),
    onProgress,
  );
}

export async function reviewFromZip(
  file: File,
  persona: Persona,
  onProgress?: (msg: string) => void,
): Promise<ReviewResponse> {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("persona", persona);

  return submitAndPoll<ReviewResponse>(
    () => fetch(`${getApiBase()}/api/review/upload`, { method: "POST", body: fd }),
    onProgress,
  );
}

export async function docsFromRepo(
  repoUrl: string,
  persona: Persona,
  tokenOrProgress?:
    | { encryptedDocsToken?: string; rawDocsToken?: string }
    | ((msg: string) => void),
  onProgress?: (msg: string) => void,
): Promise<DocsResponse> {
  const tokenBundle =
    typeof tokenOrProgress === "object" && tokenOrProgress !== null
      ? tokenOrProgress
      : undefined;
  const progressCb =
    typeof tokenOrProgress === "function" ? tokenOrProgress : onProgress;

  const payload: {
    repo_url: string;
    persona: Persona;
    encrypted_docs_token?: string;
    docs_token?: string;
  } = {
    repo_url: repoUrl,
    persona,
  };

  if (tokenBundle?.encryptedDocsToken) {
    payload.encrypted_docs_token = tokenBundle.encryptedDocsToken;
  }
  if (tokenBundle?.rawDocsToken) {
    payload.docs_token = tokenBundle.rawDocsToken;
  }

  return submitAndPoll<DocsResponse>(
    () =>
      fetch(`${getApiBase()}/api/docs/repo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
    progressCb,
  );
}

export async function verifyDocsToken(
  repoUrl: string,
  token: string,
): Promise<TokenVerifyResponse> {
  const res = await fetch(`${getApiBase()}/api/github/verify-docs-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repo_url: repoUrl, token }),
  });
  return handleResponse<TokenVerifyResponse>(res);
}

export async function verifyDocsTokenDirect(
  repoUrl: string,
  token: string,
): Promise<TokenVerifyResponse> {
  const match = repoUrl.match(/github\.com[:/]([\w.-]+\/[\w.-]+)/i);
  if (!match) {
    return { valid: false, message: "Invalid GitHub repository URL." };
  }

  const repoFullName = match[1].replace(/\.git$/, "");
  const res = await fetch(`https://api.github.com/repos/${repoFullName}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!res.ok) {
    return {
      valid: false,
      repo_full_name: repoFullName,
      message: `Token validation failed (HTTP ${res.status}).`,
    };
  }

  const data = await res.json();
  const canPush = Boolean(data?.permissions?.push);
  if (!canPush) {
    return {
      valid: false,
      repo_full_name: repoFullName,
      default_branch: data?.default_branch ?? null,
      message: "Token lacks push permission. Grant Contents: Read and write.",
    };
  }

  return {
    valid: true,
    repo_full_name: repoFullName,
    default_branch: data?.default_branch ?? null,
    encrypted_token: null,
    message: "Token validated via GitHub API (client-side fallback).",
  };
}

export async function docsFromZip(
  file: File,
  persona: Persona,
  onProgress?: (msg: string) => void,
): Promise<DocsResponse> {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("persona", persona);

  return submitAndPoll<DocsResponse>(
    () => fetch(`${getApiBase()}/api/docs/upload`, { method: "POST", body: fd }),
    onProgress,
  );
}
