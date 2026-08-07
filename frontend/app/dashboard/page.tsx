"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";

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
import { TreeView } from "@/src/components/TreeView";
import { createVisualizationBundle, getConnectedNodeIds } from "@/src/utils/graphAdapter";

const FaultyTerminal = dynamic(() => import("@/app/components/FaultyTerminal"), {
  ssr: false,
});

const PERSONAS: Persona[] = [
  "Intern",
  "Student",
  "Frontend Developer",
  "Backend Developer",
];
const DEMO_REPO = "https://github.com/ShUbHaMHiReMaT/-GoGemba-";

type ResultTab = "review" | "docs" | "graphs";
type InputMode = "repo" | "zip";
type VisualizationMode = "split" | "graph" | "tree";

function LoadingSkeleton() {
  return (
    <div className="card" style={{ display: "grid", gap: 14 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 4,
        }}
      >
        <div className="spinner" />
        <span
          style={{ color: "var(--ink-2)", fontSize: 14, fontWeight: 600 }}
        >
          AI agents are processing your repository...
        </span>
      </div>
      {[140, 90, 200, 110, 80].map((h, i) => (
        <div key={i} className="skeleton" style={{ height: h, borderRadius: 8 }} />
      ))}
    </div>
  );
}

function EmptyState({ tab }: { tab: ResultTab }) {
  const map = {
    review: {
      icon: "Review",
      title: "Code Reviewer Ready",
      desc: "Enter a repository URL or upload a ZIP and click Run to start the multi-agent code review.",
    },
    docs: {
      icon: "Docs",
      title: "Docs Generator Ready",
      desc: "Generate README, docstrings, modular docs, onboarding guide, and dependency graphs.",
    },
    graphs: {
      icon: "Graph",
      title: "Graphs Ready",
      desc: "Run the Documentation Generator to see dependency, execution, and knowledge graphs.",
    },
  };

  const { icon, title, desc } = map[tab];
  return (
    <div className="card empty-state">
      <div className="icon">{icon}</div>
      <h3>{title}</h3>
      <p>{desc}</p>
    </div>
  );
}

export default function DashboardPage() {
  const [persona, setPersona] = useState<Persona>("Student");
  const [repoUrl, setRepoUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [inputMode, setInputMode] = useState<InputMode>("repo");

  const [reviewData, setReviewData] = useState<ReviewResponse | null>(null);
  const [docsData, setDocsData] = useState<DocsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [docsPat, setDocsPat] = useState("");
  const [encryptedDocsToken, setEncryptedDocsToken] = useState<string | null>(null);
  const [rawDocsToken, setRawDocsToken] = useState<string | null>(null);
  const [tokenStatus, setTokenStatus] = useState<string | null>(null);
  const [verifyingToken, setVerifyingToken] = useState(false);

  const [resultTab, setResultTab] = useState<ResultTab>("review");
  const [visualizationMode, setVisualizationMode] =
    useState<VisualizationMode>("split");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [graphExpanded, setGraphExpanded] = useState(false);
  const [treeExpanded, setTreeExpanded] = useState(false);

  const visualization = useMemo(
    () => (docsData ? createVisualizationBundle(docsData, "dependency_graph") : null),
    [docsData],
  );

  const selectedNode = useMemo(
    () =>
      visualization?.graph.nodes.find((node) => node.id === selectedNodeId) ??
      null,
    [selectedNodeId, visualization],
  );

  const connectedNodeIds = useMemo(
    () =>
      visualization
        ? getConnectedNodeIds(visualization.graph, selectedNodeId)
        : new Set<string>(),
    [selectedNodeId, visualization],
  );

  useEffect(() => {
    setSelectedNodeId(null);
  }, [docsData?.run_id]);

  useEffect(() => {
    if (visualizationMode === "tree") {
      setGraphExpanded(false);
    }
  }, [visualizationMode]);

  useEffect(() => {
    if (visualizationMode === "graph") {
      setTreeExpanded(false);
    }
  }, [visualizationMode]);

  async function run(mode: "repo" | "zip") {
    if (mode === "repo" && !repoUrl) {
      setError("Please enter a repository URL.");
      return;
    }
    if (mode === "zip" && !file) {
      setError("Please select a ZIP file.");
      return;
    }
    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      if (resultTab === "review" || resultTab === "graphs") {
        const doReview = resultTab === "review";
        if (doReview) {
          const data =
            mode === "repo"
              ? await reviewFromRepo(repoUrl, persona)
              : await reviewFromZip(file!, persona);
          setReviewData(data);
          setSuccess(
            `Review complete - ${data.findings.length} finding(s) across ${data.reviewed_files.length} file(s).`,
          );
        } else {
          const data =
            mode === "repo"
              ? await docsFromRepo(repoUrl, persona, {
                  encryptedDocsToken: encryptedDocsToken ?? undefined,
                  rawDocsToken: rawDocsToken ?? undefined,
                })
              : await docsFromZip(file!, persona);
          setDocsData(data);
          setSuccess("Graphs generated successfully.");
        }
      } else {
        const data =
          mode === "repo"
            ? await docsFromRepo(repoUrl, persona, {
                encryptedDocsToken: encryptedDocsToken ?? undefined,
                rawDocsToken: rawDocsToken ?? undefined,
              })
            : await docsFromZip(file!, persona);
        setDocsData(data);
        setSuccess("Documentation generated successfully.");
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Request failed. Check the console for details.",
      );
    } finally {
      setLoading(false);
    }
  }

  const hasResults = reviewData !== null || docsData !== null;

  async function handleVerifyDocsToken() {
    if (!repoUrl) {
      setError("Enter repository URL before verifying PAT.");
      return;
    }
    if (!docsPat.trim()) {
      setError("Enter a fine-grained PAT to verify.");
      return;
    }

    setError(null);
    setTokenStatus(null);
    setVerifyingToken(true);
    try {
      const result = await verifyDocsToken(repoUrl, docsPat.trim());
      if (!result.valid || !result.encrypted_token) {
        setEncryptedDocsToken(null);
        setRawDocsToken(null);
        setTokenStatus(result.message || "Token verification failed.");
        return;
      }

      setEncryptedDocsToken(result.encrypted_token);
      setRawDocsToken(null);
      setTokenStatus(
        `PAT verified for ${result.repo_full_name ?? "repo"}${
          result.default_branch
            ? ` (default branch: ${result.default_branch})`
            : ""
        }.`,
      );
      setDocsPat("");
    } catch (err) {
      setEncryptedDocsToken(null);
      const msg =
        err instanceof Error ? err.message : "Token verification failed.";
      const lower = msg.toLowerCase();

      if (
        lower.includes("http 404") ||
        lower.includes("not found") ||
        lower.includes("endpoint")
      ) {
        const fallback = await verifyDocsTokenDirect(repoUrl, docsPat.trim());
        if (fallback.valid) {
          setRawDocsToken(docsPat.trim());
          setTokenStatus(
            `PAT verified client-side for ${fallback.repo_full_name ?? "repo"}${
              fallback.default_branch
                ? ` (default branch: ${fallback.default_branch})`
                : ""
            }.`,
          );
          setDocsPat("");
        } else {
          setRawDocsToken(null);
          setTokenStatus(fallback.message || "Token verification failed.");
        }
      } else {
        setRawDocsToken(null);
        setTokenStatus(msg);
      }
    } finally {
      setVerifyingToken(false);
    }
  }

  return (
    <div className="dashboard-shell">
      <div className="dashboard-terminal-bg" aria-hidden>
        <FaultyTerminal
          scale={1.45}
          gridMul={[2, 1]}
          digitSize={1.2}
          timeScale={0.45}
          scanlineIntensity={0.45}
          glitchAmount={1}
          flickerAmount={1}
          noiseAmp={1}
          chromaticAberration={0}
          dither={0}
          curvature={0.08}
          tint="#A7EF9E"
          mouseReact
          mouseStrength={0.35}
          pageLoadAnimation
          brightness={0.5}
          style={{ opacity: 0.22 }}
        />
      </div>
      <div className="dashboard-scanlines" aria-hidden />
      <div className="dashboard-scanbeam" aria-hidden />

      <nav className="nav">
        <Link href="/" className="nav-brand">
          <span style={{ marginRight: 8 }}>[]</span>
          Cypher<span className="nav-brand-dim">AI</span>
        </Link>
        <span style={{ color: "var(--border)", fontSize: 18 }}>/</span>
        <span style={{ color: "var(--ink-2)", fontSize: 14 }}>Dashboard</span>
        <span className="nav-sep" />
        {hasResults && (
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => {
              setReviewData(null);
              setDocsData(null);
              setSuccess(null);
              setError(null);
            }}
          >
            Clear results
          </button>
        )}
      </nav>

      <main className="container dashboard-main" style={{ paddingTop: 20 }}>
        <div className="dashboard-grid">
          <aside className="dashboard-sidebar">
            <div className="card" style={{ display: "grid", gap: 20 }}>
              <div className="sidebar-section">
                <div className="label">Action</div>
                <div style={{ display: "flex", gap: 8 }}>
                  {(["review", "docs", "graphs"] as ResultTab[]).map((t) => (
                    <button
                      key={t}
                      className={`btn btn-sm ${
                        resultTab === t ? "btn-primary" : "btn-secondary"
                      }`}
                      style={{ flex: 1, textTransform: "capitalize" }}
                      onClick={() => setResultTab(t)}
                      disabled={loading}
                    >
                      {t === "review"
                        ? "Review"
                        : t === "docs"
                          ? "Docs"
                          : "Graphs"}
                    </button>
                  ))}
                </div>
              </div>

              <div className="sidebar-section">
                <div className="label">Persona</div>
                <div className="persona-grid">
                  {PERSONAS.map((p) => (
                    <button
                      key={p}
                      className={`persona-chip ${persona === p ? "active" : ""}`}
                      onClick={() => setPersona(p)}
                      disabled={loading}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>

              <div className="sidebar-section">
                <div className="label">Input Source</div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    className={`btn btn-sm ${
                      inputMode === "repo" ? "btn-primary" : "btn-secondary"
                    }`}
                    style={{ flex: 1 }}
                    onClick={() => setInputMode("repo")}
                    disabled={loading}
                  >
                    GitHub URL
                  </button>
                  <button
                    className={`btn btn-sm ${
                      inputMode === "zip" ? "btn-primary" : "btn-secondary"
                    }`}
                    style={{ flex: 1 }}
                    onClick={() => setInputMode("zip")}
                    disabled={loading}
                  >
                    ZIP Upload
                  </button>
                </div>
              </div>

              {inputMode === "repo" ? (
                <div className="sidebar-section">
                  <label htmlFor="repo-url" className="label">
                    Repository URL
                  </label>
                  <input
                    id="repo-url"
                    className="input"
                    placeholder="https://github.com/owner/repo"
                    value={repoUrl}
                    onChange={(e) => setRepoUrl(e.target.value)}
                    disabled={loading}
                    onKeyDown={(e) => e.key === "Enter" && run("repo")}
                  />
                  <button
                    className="btn btn-ghost btn-sm"
                    style={{
                      marginTop: 6,
                      width: "100%",
                      justifyContent: "flex-start",
                    }}
                    onClick={() => setRepoUrl(DEMO_REPO)}
                    disabled={loading}
                  >
                    Try Demo Repo
                  </button>
                  <button
                    id="run-repo-btn"
                    className="btn btn-primary btn-full"
                    style={{ marginTop: 8 }}
                    onClick={() => run("repo")}
                    disabled={loading}
                  >
                    {loading ? (
                      <>
                        <div
                          className="spinner"
                          style={{ borderTopColor: "#fff" }}
                        />
                        Processing...
                      </>
                    ) : (
                      "Run with Repo URL"
                    )}
                  </button>

                  <div
                    className="card-inset"
                    style={{ marginTop: 10, display: "grid", gap: 8 }}
                  >
                    <label
                      htmlFor="docs-pat"
                      className="label"
                      style={{ marginBottom: 0 }}
                    >
                      GitHub PAT for README push (optional)
                    </label>
                    <input
                      id="docs-pat"
                      className="input"
                      type="password"
                      autoComplete="off"
                      placeholder="github_pat_..."
                      value={docsPat}
                      onChange={(e) => setDocsPat(e.target.value)}
                      disabled={loading || verifyingToken}
                    />
                    <button
                      className="btn btn-secondary btn-full"
                      onClick={handleVerifyDocsToken}
                      disabled={loading || verifyingToken}
                    >
                      {verifyingToken ? "Verifying..." : "Verify + Encrypt PAT"}
                    </button>
                    {tokenStatus && (
                      <div
                        style={{
                          fontSize: 12,
                          color: encryptedDocsToken || rawDocsToken
                            ? "var(--success)"
                            : "var(--danger)",
                        }}
                      >
                        {tokenStatus}
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="sidebar-section">
                  <label htmlFor="zip-upload" className="label">
                    ZIP File
                  </label>
                  <input
                    id="zip-upload"
                    className="input"
                    type="file"
                    accept=".zip"
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                    disabled={loading}
                    style={{ padding: "8px 12px" }}
                  />
                  {file && (
                    <div
                      style={{
                        fontSize: 12,
                        color: "var(--success)",
                        marginTop: 6,
                      }}
                    >
                      {file.name} ({(file.size / 1024).toFixed(0)} KB)
                    </div>
                  )}
                  <button
                    id="run-zip-btn"
                    className="btn btn-primary btn-full"
                    style={{ marginTop: 8 }}
                    onClick={() => run("zip")}
                    disabled={loading}
                  >
                    {loading ? (
                      <>
                        <div
                          className="spinner"
                          style={{ borderTopColor: "#fff" }}
                        />
                        Processing...
                      </>
                    ) : (
                      "Run with ZIP"
                    )}
                  </button>
                </div>
              )}

              {error && (
                <div className="alert alert-error sidebar-section">{error}</div>
              )}
              {success && (
                <div className="alert alert-success sidebar-section">
                  {success}
                </div>
              )}

              <div
                className="card-inset"
                style={{
                  fontSize: 12,
                  color: "var(--ink-2)",
                  lineHeight: 1.6,
                }}
              >
                <strong style={{ color: "var(--ink)" }}>Tip:</strong> Select a
                persona to adapt the output tone. Use "Try Demo Repo" to
                auto-fill a sample repository.
              </div>
            </div>
          </aside>

          <section className="dashboard-results">
            {loading && <LoadingSkeleton />}

            {!loading && (
              <>
                {hasResults && (
                  <div className="tabs">
                    {reviewData !== null && (
                      <button
                        id="tab-review"
                        className={`tab ${resultTab === "review" ? "active" : ""}`}
                        onClick={() => setResultTab("review")}
                      >
                        Code Review
                        <span className="tab-count">
                          {reviewData.findings.length}
                        </span>
                      </button>
                    )}
                    {docsData !== null && (
                      <button
                        id="tab-docs"
                        className={`tab ${resultTab === "docs" ? "active" : ""}`}
                        onClick={() => setResultTab("docs")}
                      >
                        Documentation
                      </button>
                    )}
                    {docsData !== null && (
                      <button
                        id="tab-graphs"
                        className={`tab ${resultTab === "graphs" ? "active" : ""}`}
                        onClick={() => setResultTab("graphs")}
                      >
                        Graphs
                      </button>
                    )}
                  </div>
                )}

                {resultTab === "review" &&
                  (reviewData ? (
                    <ReviewResults data={reviewData} />
                  ) : (
                    <EmptyState tab="review" />
                  ))}

                {resultTab === "docs" &&
                  (docsData ? (
                    <DocsResults data={docsData} />
                  ) : (
                    <EmptyState tab="docs" />
                  ))}

                {resultTab === "graphs" &&
                  (docsData ? (
                    <div className="grid" style={{ gap: 16 }}>
                      <div className="viz-toolbar card">
                        <div className="viz-toolbar-row">
                          <button className="btn btn-sm btn-primary" type="button">
                            Dependency
                          </button>
                        </div>
                        <div className="viz-toolbar-row">
                          {([
                            ["split", "Split View"],
                            ["graph", "Graph View"],
                            ["tree", "Tree View"],
                          ] as Array<[VisualizationMode, string]>).map(
                            ([mode, label]) => (
                              <button
                                key={mode}
                                className={`btn btn-sm ${
                                  visualizationMode === mode
                                    ? "btn-primary"
                                    : "btn-secondary"
                                }`}
                                onClick={() => setVisualizationMode(mode)}
                              >
                                {label}
                              </button>
                            ),
                          )}
                        </div>
                      </div>

                      <div className="viz-stats-grid">
                        <div className="viz-stat-card">
                          <span>Files mapped</span>
                          <strong>{visualization?.stats.fileCount ?? 0}</strong>
                        </div>
                        <div className="viz-stat-card">
                          <span>Folders</span>
                          <strong>{visualization?.stats.folderCount ?? 0}</strong>
                        </div>
                        <div className="viz-stat-card">
                          <span>Edges</span>
                          <strong>{visualization?.stats.edgeCount ?? 0}</strong>
                        </div>
                        <div className="viz-stat-card">
                          <span>Hotspot</span>
                          <strong>
                            {selectedNode?.label ??
                              visualization?.stats.densestNodeId
                                ?.split("/")
                                .pop() ??
                              "n/a"}
                          </strong>
                        </div>
                      </div>

                      <div
                        className={`viz-shell mode-${visualizationMode} ${
                          graphExpanded ? "expanded-graph" : ""
                        } ${
                          treeExpanded ? "expanded-tree" : ""
                        }`}
                      >
                        {visualization && visualizationMode !== "graph" && (
                          <TreeView
                            tree={visualization.tree}
                            graph={visualization.graph}
                            selectedNodeId={selectedNodeId}
                            onNodeSelect={setSelectedNodeId}
                            isExpanded={treeExpanded}
                            onToggleExpand={() =>
                              setTreeExpanded((current) => !current)
                            }
                          />
                        )}

                        {visualization && visualizationMode !== "tree" && (
                          <GraphView
                            title={
                              "Dependency Graph"
                            }
                            graph={visualization.graph}
                            selectedNodeId={selectedNodeId}
                            onNodeSelect={setSelectedNodeId}
                            isExpanded={graphExpanded}
                            onToggleExpand={() =>
                              setGraphExpanded((current) => !current)
                            }
                          />
                        )}

                        <aside className="viz-panel detail-panel">
                          <div className="viz-panel-header">
                            <div>
                              <h3>Inspector</h3>
                              <p>
                                Selection-aware context for the active graph.
                              </p>
                            </div>
                          </div>

                          {selectedNode ? (
                            <div className="detail-stack">
                              <div className="detail-card">
                                <span className="detail-kicker">
                                  Selected file
                                </span>
                                <strong>{selectedNode.label}</strong>
                                <code>{selectedNode.path}</code>
                              </div>
                              <div className="detail-grid">
                                <div className="detail-metric">
                                  <span>Group</span>
                                  <strong>{selectedNode.group}</strong>
                                </div>
                                <div className="detail-metric">
                                  <span>Inbound</span>
                                  <strong>{selectedNode.inbound}</strong>
                                </div>
                                <div className="detail-metric">
                                  <span>Outbound</span>
                                  <strong>{selectedNode.outbound}</strong>
                                </div>
                                <div className="detail-metric">
                                  <span>Neighbors</span>
                                  <strong>
                                    {Math.max(connectedNodeIds.size - 1, 0)}
                                  </strong>
                                </div>
                              </div>
                            </div>
                          ) : (
                            <div className="detail-empty">
                              Select a file in the graph or tree to inspect its
                              dependency neighborhood.
                            </div>
                          )}

                          <div className="detail-stack">
                            <div className="detail-card">
                              <span className="detail-kicker">Run metadata</span>
                              <strong>{docsData.persona}</strong>
                              <span>
                                {docsData.doc_rot_detected
                                  ? "README was regenerated after doc-rot detection."
                                  : "Documentation generated from the current backend pipeline."}
                              </span>
                            </div>
                            <div className="detail-card">
                              <span className="detail-kicker">
                                Available outputs
                              </span>
                              <span>
                                {Object.keys(docsData.modular_docs ?? {}).length}{" "}
                                modular docs
                              </span>
                              <span>
                                {Object.keys(docsData.docstrings ?? {}).length}{" "}
                                docstring files
                              </span>
                            </div>
                          </div>
                        </aside>
                      </div>
                    </div>
                  ) : (
                    <EmptyState tab="graphs" />
                  ))}
              </>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
