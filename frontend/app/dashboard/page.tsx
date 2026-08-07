"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { DocsResults } from "@/components/DocsResults";
import { ReviewResults } from "@/components/ReviewResults";
import {
  docsFromRepo,
  docsFromZip,
  reviewFromRepo,
  reviewFromZip,
  verifyDocsToken,
  verifyDocsTokenDirect,
} from "@/lib/api";
import { DocsResponse, Persona, ReviewResponse } from "@/lib/types";
import { GraphView } from "@/src/components/GraphView";
import { SpaceView } from "@/src/components/SpaceView";
import { ThemeToggle } from "@/src/components/ThemeToggle";
import { TreeView } from "@/src/components/TreeView";
import { createVisualizationBundle } from "@/src/utils/graphAdapter";

import "./dashboard.css";

const PERSONAS: Persona[] = [
  "Intern",
  "Student",
  "Frontend Developer",
  "Backend Developer",
];
const DEMO_REPO = "https://github.com/ShUbHaMHiReMaT/-GoGemba-";

type ViewTab = "review" | "docs" | "graphs";
type InputMode = "repo" | "zip";
type VizMode = "graph" | "tree" | "space";
type TrackState = "idle" | "running" | "done" | "error";

export default function DashboardPage() {
  /* ── Inputs ─────────────────────────────────────────────────────────── */
  const [persona, setPersona] = useState<Persona>("Student");
  const [repoUrl, setRepoUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [inputMode, setInputMode] = useState<InputMode>("repo");

  const [docsPat, setDocsPat] = useState("");
  const [encryptedDocsToken, setEncryptedDocsToken] = useState<string | null>(null);
  const [rawDocsToken, setRawDocsToken] = useState<string | null>(null);
  const [tokenStatus, setTokenStatus] = useState<string | null>(null);
  const [tokenOk, setTokenOk] = useState(false);
  const [verifyingToken, setVerifyingToken] = useState(false);

  /* ── Results ────────────────────────────────────────────────────────── */
  const [reviewData, setReviewData] = useState<ReviewResponse | null>(null);
  const [docsData, setDocsData] = useState<DocsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Per-track progress so a single run can report each pipeline independently.
  const [reviewTrack, setReviewTrack] = useState<TrackState>("idle");
  const [docsTrack, setDocsTrack] = useState<TrackState>("idle");

  /* ── View ───────────────────────────────────────────────────────────── */
  const [viewTab, setViewTab] = useState<ViewTab>("review");
  const [vizMode, setVizMode] = useState<VizMode>("graph");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const visualization = useMemo(
    () => (docsData ? createVisualizationBundle(docsData, "dependency_graph") : null),
    [docsData],
  );

  useEffect(() => {
    setSelectedNodeId(null);
  }, [docsData?.run_id]);

  const hasResults = reviewData !== null || docsData !== null;

  const statusState = loading
    ? "running"
    : error && !hasResults
      ? "error"
      : hasResults
        ? "ready"
        : "idle";

  const statusText = loading
    ? "Analysing"
    : error && !hasResults
      ? "Failed"
      : hasResults
        ? "Ready"
        : "Idle";

  /* ── Run: one action, every pipeline ────────────────────────────────── */

  async function runAll() {
    if (inputMode === "repo" && !repoUrl.trim()) {
      setError("Enter a repository URL first.");
      return;
    }
    if (inputMode === "zip" && !file) {
      setError("Select a ZIP file first.");
      return;
    }

    setLoading(true);
    setError(null);
    setSuccess(null);
    setReviewTrack("running");
    setDocsTrack("running");

    const reviewTask = (
      inputMode === "repo"
        ? reviewFromRepo(repoUrl.trim(), persona)
        : reviewFromZip(file!, persona)
    )
      .then((data) => {
        setReviewData(data);
        setReviewTrack("done");
        return data;
      })
      .catch((err) => {
        setReviewTrack("error");
        throw err;
      });

    const docsTask = (
      inputMode === "repo"
        ? docsFromRepo(repoUrl.trim(), persona, {
            encryptedDocsToken: encryptedDocsToken ?? undefined,
            rawDocsToken: rawDocsToken ?? undefined,
          })
        : docsFromZip(file!, persona)
    )
      .then((data) => {
        setDocsData(data);
        setDocsTrack("done");
        return data;
      })
      .catch((err) => {
        setDocsTrack("error");
        throw err;
      });

    // allSettled: one pipeline failing must not discard the other's result.
    const [reviewResult, docsResult] = await Promise.allSettled([reviewTask, docsTask]);

    const wins: string[] = [];
    const fails: string[] = [];

    if (reviewResult.status === "fulfilled") {
      const data = reviewResult.value;
      wins.push(
        `Review: ${data.findings.length} finding(s) across ${data.reviewed_files.length} file(s)`,
      );
    } else {
      fails.push(`Review failed — ${messageOf(reviewResult.reason)}`);
    }

    if (docsResult.status === "fulfilled") {
      const data = docsResult.value;
      const nodes = data.dependency_graph?.nodes?.length ?? 0;
      wins.push(`Docs + graphs: ${nodes} node(s) mapped`);
    } else {
      fails.push(`Docs failed — ${messageOf(docsResult.reason)}`);
    }

    setSuccess(wins.length ? wins.join(" · ") : null);
    setError(fails.length ? fails.join(" | ") : null);

    // Land on something that actually has content.
    if (reviewResult.status === "fulfilled") setViewTab("review");
    else if (docsResult.status === "fulfilled") setViewTab("docs");

    setLoading(false);
  }

  function messageOf(reason: unknown): string {
    return reason instanceof Error ? reason.message : "unknown error";
  }

  async function handleVerifyDocsToken() {
    if (!repoUrl.trim()) {
      setTokenStatus("Enter the repository URL below, then verify.");
      setTokenOk(false);
      return;
    }
    if (!docsPat.trim()) {
      setTokenStatus("Paste a fine-grained PAT to verify.");
      setTokenOk(false);
      return;
    }

    setError(null);
    setTokenStatus(null);
    setVerifyingToken(true);
    try {
      const result = await verifyDocsToken(repoUrl.trim(), docsPat.trim());
      if (!result.valid || !result.encrypted_token) {
        setEncryptedDocsToken(null);
        setRawDocsToken(null);
        setTokenOk(false);
        setTokenStatus(result.message || "Token verification failed.");
        return;
      }

      setEncryptedDocsToken(result.encrypted_token);
      setRawDocsToken(null);
      setTokenOk(true);
      setTokenStatus(
        `Verified for ${result.repo_full_name ?? "repo"}${
          result.default_branch ? ` · branch ${result.default_branch}` : ""
        }`,
      );
      setDocsPat("");
    } catch (err) {
      setEncryptedDocsToken(null);
      const msg = err instanceof Error ? err.message : "Token verification failed.";
      const lower = msg.toLowerCase();

      if (
        lower.includes("http 404") ||
        lower.includes("not found") ||
        lower.includes("endpoint")
      ) {
        const fallback = await verifyDocsTokenDirect(repoUrl.trim(), docsPat.trim());
        if (fallback.valid) {
          setRawDocsToken(docsPat.trim());
          setTokenOk(true);
          setTokenStatus(
            `Verified client-side for ${fallback.repo_full_name ?? "repo"}${
              fallback.default_branch ? ` · branch ${fallback.default_branch}` : ""
            }`,
          );
          setDocsPat("");
        } else {
          setRawDocsToken(null);
          setTokenOk(false);
          setTokenStatus(fallback.message || "Token verification failed.");
        }
      } else {
        setRawDocsToken(null);
        setTokenOk(false);
        setTokenStatus(msg);
      }
    } finally {
      setVerifyingToken(false);
    }
  }

  function clearAll() {
    setReviewData(null);
    setDocsData(null);
    setSuccess(null);
    setError(null);
    setReviewTrack("idle");
    setDocsTrack("idle");
  }

  /* ── Tab metadata ───────────────────────────────────────────────────── */

  const tabs: Array<{ id: ViewTab; name: string; meta: string; ready: boolean }> = [
    {
      id: "review",
      name: "Review",
      meta: reviewData
        ? `${reviewData.findings.length} findings · ${reviewData.reviewed_files.length} files`
        : "multi-agent analysis",
      ready: reviewData !== null,
    },
    {
      id: "docs",
      name: "Docs",
      meta: docsData
        ? `readme · ${Object.keys(docsData.modular_docs ?? {}).length} modules`
        : "readme + onboarding",
      ready: docsData !== null,
    },
    {
      id: "graphs",
      name: "Graphs",
      meta: visualization
        ? `${visualization.stats.fileCount} files · ${visualization.stats.edgeCount} edges`
        : "dependency map",
      ready: docsData !== null,
    },
  ];

  return (
    <div className="dx-shell">
      <div className="dx-grid-bg" aria-hidden />

      <div className="dx-content">
        <header className="dx-topbar">
          <Link href="/" className="dx-brand">
            <span className="dx-brand-mark" aria-hidden />
            ARGUS
          </Link>
          <span className="dx-crumb">/ Console</span>

          <span className="dx-topbar-spacer" />

          <span className="dx-status" data-state={statusState}>
            <span className="dx-status-led" />
            {statusText}
          </span>

          <ThemeToggle />

          {hasResults && !loading && (
            <button className="dx-ghost-btn" onClick={clearAll}>
              Clear
            </button>
          )}
        </header>

        <div className="dx-body">
          {/* ── Left rail ────────────────────────────────────────────── */}
          <aside className="dx-rail">
            <section className="dx-sec">
              <div className="dx-sec-head">
                <span className="dx-sec-num">01</span>
                <span className="dx-sec-title">Source</span>
                <span className="dx-sec-rule" />
              </div>

              <div className="dx-seg" style={{ marginBottom: 14 }}>
                <button
                  className={inputMode === "repo" ? "on" : ""}
                  onClick={() => setInputMode("repo")}
                  disabled={loading}
                >
                  GitHub URL
                </button>
                <button
                  className={inputMode === "zip" ? "on" : ""}
                  onClick={() => setInputMode("zip")}
                  disabled={loading}
                >
                  ZIP Upload
                </button>
              </div>

              {inputMode === "repo" ? (
                <>
                  {/* PAT is requested first, then the repository URL. */}
                  <div style={{ marginBottom: 14 }}>
                    <label htmlFor="docs-pat" className="dx-label">
                      GitHub PAT — optional
                    </label>
                    <input
                      id="docs-pat"
                      className="dx-input"
                      type="password"
                      autoComplete="off"
                      placeholder="github_pat_…"
                      value={docsPat}
                      onChange={(e) => setDocsPat(e.target.value)}
                      disabled={loading || verifyingToken}
                    />
                    <button
                      className="dx-btn"
                      style={{ marginTop: 6 }}
                      onClick={handleVerifyDocsToken}
                      disabled={loading || verifyingToken}
                    >
                      {verifyingToken ? "Verifying…" : "Verify + Encrypt"}
                    </button>
                    {tokenStatus ? (
                      <div className={`dx-hint ${tokenOk ? "ok" : "bad"}`}>
                        {tokenStatus}
                      </div>
                    ) : (
                      <div className="dx-hint">
                        Enables README push back to the repo. Verification needs the
                        URL below.
                      </div>
                    )}
                  </div>

                  <div>
                    <label htmlFor="repo-url" className="dx-label">
                      Repository URL
                    </label>
                    <input
                      id="repo-url"
                      className="dx-input"
                      placeholder="https://github.com/owner/repo"
                      value={repoUrl}
                      onChange={(e) => setRepoUrl(e.target.value)}
                      disabled={loading}
                      onKeyDown={(e) => e.key === "Enter" && runAll()}
                    />
                    <button
                      className="dx-btn"
                      style={{ marginTop: 6 }}
                      onClick={() => setRepoUrl(DEMO_REPO)}
                      disabled={loading}
                    >
                      Load demo repo
                    </button>
                  </div>
                </>
              ) : (
                <div>
                  <label htmlFor="zip-upload" className="dx-label">
                    Archive
                  </label>
                  <input
                    id="zip-upload"
                    className="dx-input"
                    type="file"
                    accept=".zip"
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                    disabled={loading}
                  />
                  {file && (
                    <div className="dx-hint ok">
                      {file.name} · {(file.size / 1024).toFixed(0)} KB
                    </div>
                  )}
                </div>
              )}
            </section>

            <section className="dx-sec">
              <div className="dx-sec-head">
                <span className="dx-sec-num">02</span>
                <span className="dx-sec-title">Persona</span>
                <span className="dx-sec-rule" />
              </div>
              <div className="dx-personas">
                {PERSONAS.map((p) => (
                  <button
                    key={p}
                    className={`dx-persona ${persona === p ? "on" : ""}`}
                    onClick={() => setPersona(p)}
                    disabled={loading}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </section>

            <section className="dx-sec">
              <div className="dx-sec-head">
                <span className="dx-sec-num">03</span>
                <span className="dx-sec-title">Execute</span>
                <span className="dx-sec-rule" />
              </div>

              <button className="dx-run" onClick={runAll} disabled={loading}>
                {loading ? (
                  <>
                    <span className="dx-spinner" />
                    Running
                  </>
                ) : (
                  "Run analysis"
                )}
              </button>

              <div className="dx-hint" style={{ marginTop: 8 }}>
                Runs review, docs and graphs together. Switch tabs to read each
                result.
              </div>

              {error && (
                <div className="dx-alert err" style={{ marginTop: 12 }}>
                  {error}
                </div>
              )}
              {success && (
                <div className="dx-alert ok" style={{ marginTop: 10 }}>
                  {success}
                </div>
              )}
            </section>

            <a
              className="dx-btn"
              href="https://github.com/apps/argus-onewin"
              target="_blank"
              rel="noopener noreferrer"
              style={{ display: "block", textAlign: "center", marginBottom: 18 }}
            >
              Download the GitHub App
            </a>

            <div className="dx-note">
              <b>ARGUS</b> — Autonomous Review for GitHub Understanding &amp; Security.
              Persona changes the depth and register of every explanation, from
              first-week intern to production backend engineer.
            </div>
          </aside>

          {/* ── Main ─────────────────────────────────────────────────── */}
          <main className="dx-main">
            <nav className="dx-tabs">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  className={`dx-tab ${viewTab === tab.id ? "on" : ""}`}
                  onClick={() => setViewTab(tab.id)}
                >
                  <span className="dx-tab-name">{tab.name}</span>
                  <span className="dx-tab-meta">{tab.meta}</span>
                </button>
              ))}
            </nav>

            {loading && (
              <div className="dx-loading">
                <div className="dx-track" data-s={reviewTrack}>
                  <span className="dx-track-dot" />
                  <span className="dx-track-name">Code review</span>
                  <span className="dx-track-state">{reviewTrack}</span>
                </div>
                <div className="dx-track" data-s={docsTrack}>
                  <span className="dx-track-dot" />
                  <span className="dx-track-name">Docs + graphs</span>
                  <span className="dx-track-state">{docsTrack}</span>
                </div>
                <div style={{ marginTop: 14 }}>
                  {[100, 72, 88, 54].map((w, i) => (
                    <div key={i} className="dx-skel" style={{ width: `${w}%` }} />
                  ))}
                </div>
              </div>
            )}

            {!loading && viewTab === "review" && (
              reviewData ? (
                <ReviewResults data={reviewData} />
              ) : (
                <EmptyPanel
                  code="Surface 01 — Review"
                  title="Nothing reviewed yet"
                  desc="Point ARGUS at a repository and run an analysis. Six rule-based agents plus a routed model pass produce ranked, evidence-backed findings."
                />
              )
            )}

            {!loading && viewTab === "docs" && (
              docsData ? (
                <DocsResults data={docsData} />
              ) : (
                <EmptyPanel
                  code="Surface 03 — Documentation"
                  title="No documentation yet"
                  desc="Run an analysis to generate a README, per-module documentation, docstrings and an onboarding guide from the parsed source."
                />
              )
            )}

            {!loading && viewTab === "graphs" && (
              visualization ? (
                <div style={{ display: "grid", gap: 14 }}>
                  <div className="dx-seg dx-seg-viz">
                    <button
                      className={vizMode === "graph" ? "on" : ""}
                      onClick={() => setVizMode("graph")}
                    >
                      Graph
                    </button>
                    <button
                      className={vizMode === "tree" ? "on" : ""}
                      onClick={() => setVizMode("tree")}
                    >
                      Tree
                    </button>
                    <button
                      className={vizMode === "space" ? "on" : ""}
                      onClick={() => setVizMode("space")}
                    >
                      3D
                    </button>
                  </div>

                  {vizMode === "graph" && (
                    <GraphView
                      title="Dependency Graph"
                      graph={visualization.graph}
                      selectedNodeId={selectedNodeId}
                      onNodeSelect={setSelectedNodeId}
                    />
                  )}
                  {vizMode === "tree" && (
                    <TreeView
                      tree={visualization.tree}
                      graph={visualization.graph}
                      selectedNodeId={selectedNodeId}
                      onNodeSelect={setSelectedNodeId}
                    />
                  )}
                  {vizMode === "space" && (
                    <SpaceView
                      title="Dependency Space"
                      graph={visualization.graph}
                      selectedNodeId={selectedNodeId}
                      onNodeSelect={setSelectedNodeId}
                    />
                  )}
                </div>
              ) : (
                <EmptyPanel
                  code="Surface 04 — Dependency graph"
                  title="No graph yet"
                  desc="Run an analysis to map imports into an interactive dependency graph. Drag nodes, zoom, filter by layer, and expand to fullscreen."
                />
              )
            )}
          </main>
        </div>
      </div>
    </div>
  );
}

function EmptyPanel({
  code,
  title,
  desc,
}: {
  code: string;
  title: string;
  desc: string;
}) {
  return (
    <div className="dx-empty">
      <div className="dx-empty-code">{code}</div>
      <h3>{title}</h3>
      <p>{desc}</p>
    </div>
  );
}
