import { Finding, ReviewResponse } from "@/lib/types";

const SEV_ORDER: Record<Finding["severity"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const SEV_COLOR: Record<Finding["severity"], string> = {
  critical: "var(--danger)",
  high: "#e3b341",
  medium: "#f0c040",
  low: "var(--success)",
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
        <span>
          <span style={{ color: "var(--ink-2)", marginRight: 6 }}>File</span>
          <code style={{ fontSize: 13 }}>{filename}</code>
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
                  <code style={{ color: "var(--ink-2)", fontSize: 12 }}>
                    :{finding.line}
                  </code>
                </td>
                <td>
                  <div
                    style={{ fontWeight: 600, fontSize: 13, marginBottom: 3 }}
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
                      fontSize: 12,
                      background: "var(--bg-3)",
                      border: "1px solid var(--border)",
                      borderRadius: 4,
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
                      fontSize: 12,
                      fontWeight: 700,
                      color:
                        finding.confidence >= 0.8
                          ? "var(--success)"
                          : finding.confidence >= 0.5
                            ? "#e3b341"
                            : "var(--ink-2)",
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

export function ReviewResults({ data }: { data: ReviewResponse }) {
  const byFile: Record<string, Finding[]> = {};
  for (const finding of data.findings) {
    (byFile[finding.file] ??= []).push(finding);
  }

  const files = Object.keys(byFile).sort();

  return (
    <section className="grid" style={{ gap: 16 }}>
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
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 800 }}>
            Review Summary
          </h3>
          <span style={{ fontSize: 12, color: "var(--ink-2)" }}>
            Persona: <strong style={{ color: "var(--ink)" }}>{data.persona}</strong>
            {" "}·{" "}
            {data.reviewed_files.length} file(s) reviewed
          </span>
        </div>

        <SummaryBar findings={data.findings} />

        {data.summary && (
          <p
            style={{
              margin: 0,
              fontSize: 13,
              color: "var(--ink-2)",
              lineHeight: 1.8,
              whiteSpace: "pre-wrap",
              padding: "10px 0",
            }}
          >
            {data.summary}
          </p>
        )}
      </div>

      {data.findings.length === 0 ? (
        <div className="card" style={{ textAlign: "center", padding: 40 }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>OK</div>
          <h3 style={{ margin: "0 0 6px", color: "var(--success)" }}>
            No findings!
          </h3>
          <p style={{ margin: 0, fontSize: 14, color: "var(--ink-2)" }}>
            No high-confidence issues were detected.
          </p>
        </div>
      ) : (
        <div className="card">
          <h3 style={{ margin: "0 0 14px", fontSize: 15, fontWeight: 800 }}>
            Inline Findings{" "}
            <span className="tab-count" style={{ marginLeft: 6 }}>
              {data.findings.length}
            </span>
            <span
              style={{
                fontSize: 12,
                fontWeight: 400,
                color: "var(--ink-2)",
                marginLeft: 8,
              }}
            >
              grouped by file
            </span>
          </h3>

          {files.map((file) => (
            <FileGroup key={file} filename={file} findings={byFile[file]} />
          ))}
        </div>
      )}
    </section>
  );
}
