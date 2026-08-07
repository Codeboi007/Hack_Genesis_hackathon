"use client";

import { useState } from "react";

import { CodeExplainer } from "@/components/CodeExplainer";
import { Finding, ReviewResponse } from "@/lib/types";

const SEV_ORDER: Record<Finding["severity"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/* GitHub diff semantics: red carries risk, everything else stays achromatic. */
const SEV_COLOR: Record<Finding["severity"], string> = {
  critical: "var(--red)",
  high: "var(--red)",
  medium: "var(--amber)",
  low: "var(--ink-3)",
};

function SeverityBadge({ sev }: { sev: Finding["severity"] }) {
  return <span className={`badge badge-${sev}`}>{sev.toUpperCase()}</span>;
}

function SummaryBar({ findings }: { findings: Finding[] }) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const finding of findings) counts[finding.severity]++;

  return (
    <div className="summary-bar">
      <div className="summary-stat">
        <span className="num" style={{ color: "var(--ink)" }}>
          {findings.length}
        </span>
        <span className="lbl">Total</span>
      </div>
      {(["critical", "high", "medium", "low"] as Finding["severity"][]).map(
        (severity) => (
          <div key={severity} className="summary-stat">
            <span className="num" style={{ color: SEV_COLOR[severity] }}>
              {counts[severity]}
            </span>
            <span className="lbl">{severity}</span>
          </div>
        ),
      )}
    </div>
  );
}

function FileGroup({
  filename,
  findings,
}: {
  filename: string;
  findings: Finding[];
}) {
  const sorted = [...findings].sort(
    (a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity],
  );

  return (
    <div className="file-group">
      <div className="file-group-header">
        <span style={{ color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis" }}>
          {filename}
        </span>
        <span style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          {(["critical", "high", "medium", "low"] as Finding["severity"][])
            .filter((severity) =>
              sorted.some((finding) => finding.severity === severity),
            )
            .map((severity) => (
              <SeverityBadge key={severity} sev={severity} />
            ))}
        </span>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>Line</th>
              <th>Issue</th>
              <th>Severity</th>
              <th>Agent</th>
              <th>Confidence</th>
              <th>Fix Suggestion</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((finding, idx) => (
              <tr key={`${finding.file}-${finding.line}-${idx}`}>
                <td>
                  <code
                    style={{
                      fontFamily: "var(--mono)",
                      color: "var(--ink-3)",
                      fontSize: 11.5,
                    }}
                  >
                    {finding.line}
                  </code>
                </td>
                <td>
                  <div
                    style={{
                      fontWeight: 600,
                      fontSize: 13.5,
                      letterSpacing: "-0.015em",
                      color: "var(--ink)",
                      marginBottom: 4,
                    }}
                  >
                    {finding.issue_title}
                  </div>
                  <div
                    style={{
                      color: "var(--ink-2)",
                      fontSize: 12,
                      lineHeight: 1.5,
                    }}
                  >
                    {finding.explanation}
                  </div>
                </td>
                <td>
                  <SeverityBadge sev={finding.severity} />
                </td>
                <td>
                  <span
                    style={{
                      fontFamily: "var(--mono)",
                      fontSize: 10.5,
                      border: "1px solid var(--rule)",
                      padding: "2px 7px",
                      color: "var(--ink-2)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {finding.agent}
                  </span>
                </td>
                <td>
                  <div
                    style={{
                      fontFamily: "var(--mono)",
                      fontSize: 12,
                      fontWeight: 600,
                      color:
                        finding.confidence >= 0.8 ? "var(--green)" : "var(--ink-2)",
                    }}
                  >
                    {(finding.confidence * 100).toFixed(0)}%
                  </div>
                </td>
                <td>
                  <div
                    style={{
                      fontSize: 12,
                      color: "var(--ink-2)",
                      maxWidth: 260,
                      lineHeight: 1.5,
                    }}
                  >
                    {finding.fix_suggestion}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

type ReviewView = "findings" | "explainer";

export function ReviewResults({ data }: { data: ReviewResponse }) {
  const [view, setView] = useState<ReviewView>("findings");

  const byFile: Record<string, Finding[]> = {};
  for (const finding of data.findings) {
    (byFile[finding.file] ??= []).push(finding);
  }

  const files = Object.keys(byFile).sort();

  const viewSwitch = (
    <div className="ce-viewswitch">
      <button
        className={`ce-viewswitch-btn ${view === "findings" ? "active" : ""}`}
        onClick={() => setView("findings")}
      >
        Findings
      </button>
      <button
        className={`ce-viewswitch-btn ${view === "explainer" ? "active" : ""}`}
        onClick={() => setView("explainer")}
      >
        Code Explainer
      </button>
    </div>
  );

  if (view === "explainer") {
    return (
      <section className="grid" style={{ gap: 16 }}>
        {viewSwitch}
        <CodeExplainer data={data} />
      </section>
    );
  }

  return (
    <section className="grid" style={{ gap: 16 }}>
      {viewSwitch}
      <div className="card">
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 12,
            flexWrap: "wrap",
            gap: 8,
          }}
        >
          <div>
            <span className="ce-kicker">Review summary</span>
            <p
              style={{
                margin: 0,
                fontFamily: "var(--mono)",
                fontSize: 12,
                color: "var(--ink-2)",
              }}
            >
              {data.persona} · {data.reviewed_files.length} files reviewed
            </p>
          </div>
        </div>

        <SummaryBar findings={data.findings} />

        {data.summary && (
          <p
            style={{
              margin: 0,
              fontSize: 14.5,
              color: "var(--ink-2)",
              lineHeight: 1.75,
              whiteSpace: "pre-wrap",
              maxWidth: "var(--measure)",
            }}
          >
            {data.summary}
          </p>
        )}
      </div>

      {data.findings.length === 0 ? (
        <div
          className="card"
          style={{
            textAlign: "center",
            padding: "56px 28px",
            borderColor: "var(--green-line)",
            background: "var(--green-soft)",
          }}
        >
          <div className="ce-kicker" style={{ color: "var(--green)" }}>
            Clean
          </div>
          <h3
            style={{
              margin: "0 0 8px",
              fontSize: "clamp(1.3rem,2.4vw,1.8rem)",
              fontWeight: 700,
              letterSpacing: "-0.03em",
              color: "var(--ink)",
            }}
          >
            No findings above the confidence floor
          </h3>
          <p
            style={{
              margin: "0 auto",
              maxWidth: "48ch",
              fontSize: 14,
              lineHeight: 1.7,
              color: "var(--ink-2)",
            }}
          >
            Every agent reported nothing actionable. ARGUS suppresses low-confidence
            noise rather than padding the report.
          </p>
        </div>
      ) : (
        <div className="card">
          <div className="ce-section-head">
            <h3>
              Findings
              <span className="tab-count" style={{ marginLeft: 10 }}>
                {data.findings.length}
              </span>
            </h3>
            <p>Grouped by file, ranked by severity then confidence.</p>
          </div>

          {files.map((file) => (
            <FileGroup key={file} filename={file} findings={byFile[file]} />
          ))}
        </div>
      )}
    </section>
  );
}
