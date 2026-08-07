"use client";

import { useMemo, useState } from "react";

import { Finding, ReviewResponse } from "@/lib/types";

/* ─── Severity model ──────────────────────────────────────────────────── */

const SEVERITIES: Finding["severity"][] = ["critical", "high", "medium", "low"];

/* GitHub diff semantics: red escalates with risk, the rest stay achromatic so
   the eye is only ever pulled toward something that matters. */
const SEV_COLOR: Record<Finding["severity"], string> = {
  critical: "var(--red)",
  high: "var(--red)",
  medium: "var(--amber)",
  low: "var(--ink-3)",
};

/** Health penalty per finding. Critical issues dominate the score by design. */
const SEV_WEIGHT: Record<Finding["severity"], number> = {
  critical: 25,
  high: 10,
  medium: 4,
  low: 1,
};

/** Plain-English stakes, so "medium" means something to a non-engineer. */
const SEV_MEANING: Record<Finding["severity"], string> = {
  critical:
    "This can break production or expose data. Treat it as a release blocker.",
  high: "This will cause real bugs or security weakness under normal use. Fix it this sprint.",
  medium:
    "This makes the code harder to change safely and may cause bugs later. Schedule it.",
  low: "This is a polish item. It won't break anything, but fixing it improves clarity.",
};

function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

function worstSeverity(findings: Finding[]): Finding["severity"] | null {
  for (const severity of SEVERITIES) {
    if (findings.some((f) => f.severity === severity)) return severity;
  }
  return null;
}

/* ─── Health score ────────────────────────────────────────────────────── */

type Health = {
  score: number;
  label: string;
  counts: Record<Finding["severity"], number>;
};

function computeHealth(findings: Finding[], fileCount: number): Health {
  const counts: Record<Finding["severity"], number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  };
  for (const finding of findings) counts[finding.severity] += 1;

  const penalty = SEVERITIES.reduce(
    (total, severity) => total + counts[severity] * SEV_WEIGHT[severity],
    0,
  );
  // Normalise against repo size so a large repo isn't punished for having more files.
  const scale = Math.max(1, Math.sqrt(Math.max(fileCount, 1)));
  const raw = 10 - penalty / (10 * scale);
  const score = Math.max(0, Math.min(10, Math.round(raw * 10) / 10));

  let label: string;
  if (counts.critical > 0) {
    label = `${counts.critical} critical issue${counts.critical > 1 ? "s" : ""} need attention now`;
  } else if (counts.high > 0) {
    label = `No critical issues — ${counts.high} high-severity item${counts.high > 1 ? "s" : ""} to resolve`;
  } else if (findings.length > 0) {
    label = "Solid — only maintainability items remain";
  } else {
    label = "Clean — no high-confidence issues detected";
  }

  return { score, label, counts };
}

function ScoreMeter({ score }: { score: number }) {
  // Ten blocks, filled proportionally: ■■■■■■■□□□
  const filled = Math.round(score);
  const color =
    score >= 8 ? "var(--green)" : score >= 5 ? "var(--amber)" : "var(--red)";

  return (
    <div
      className="ce-meter"
      role="meter"
      aria-valuenow={score}
      aria-valuemin={0}
      aria-valuemax={10}
      aria-label={`Code health score ${score} out of 10`}
    >
      {Array.from({ length: 10 }, (_, i) => (
        <span
          key={i}
          className={`ce-meter-block ${i < filled ? "filled" : ""}`}
          style={i < filled ? { background: color, borderColor: color } : undefined}
        />
      ))}
    </div>
  );
}

function SeverityBar({ counts }: { counts: Health["counts"] }) {
  const total = SEVERITIES.reduce((sum, s) => sum + counts[s], 0);
  if (total === 0) return null;

  return (
    <div className="ce-sevbar">
      <div className="ce-sevbar-track">
        {SEVERITIES.filter((s) => counts[s] > 0).map((severity) => (
          <span
            key={severity}
            className="ce-sevbar-seg"
            style={{
              width: `${(counts[severity] / total) * 100}%`,
              background: SEV_COLOR[severity],
            }}
            title={`${counts[severity]} ${severity}`}
          />
        ))}
      </div>
      <div className="ce-sevbar-legend">
        {SEVERITIES.filter((s) => counts[s] > 0).map((severity) => (
          <span key={severity} className="ce-sevbar-key">
            <i style={{ background: SEV_COLOR[severity] }} />
            {counts[severity]} {severity}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ─── Health summary card ─────────────────────────────────────────────── */

function HealthCard({
  data,
  health,
  fileCount,
}: {
  data: ReviewResponse;
  health: Health;
  fileCount: number;
}) {
  return (
    <div className="card ce-health">
      <div className="ce-health-head">
        <div>
          <span className="ce-kicker">Code Health</span>
          <div className="ce-score-row">
            <strong className="ce-score">{health.score.toFixed(1)}</strong>
            <span className="ce-score-max">/ 10</span>
          </div>
          <p className="ce-health-label">{health.label}</p>
        </div>
        <div className="ce-health-stats">
          <div className="ce-stat">
            <strong>{fileCount}</strong>
            <span>files reviewed</span>
          </div>
          <div className="ce-stat">
            <strong>{data.findings.length}</strong>
            <span>findings</span>
          </div>
          <div className="ce-stat">
            <strong>{data.persona}</strong>
            <span>persona</span>
          </div>
        </div>
      </div>

      <ScoreMeter score={health.score} />
      <SeverityBar counts={health.counts} />
    </div>
  );
}

/* ─── File cards ──────────────────────────────────────────────────────── */

function FileCard({
  path,
  summary,
  findings,
  symbols,
}: {
  path: string;
  summary?: string;
  findings: Finding[];
  symbols: string[];
}) {
  const risk = worstSeverity(findings);

  return (
    <div className="ce-file-card">
      <div className="ce-file-head">
        <code className="ce-path-badge" title={path}>
          <span className="ce-path-dir">
            {path.includes("/") ? `${path.slice(0, path.lastIndexOf("/"))}/` : ""}
          </span>
          {fileName(path)}
        </code>
        <span
          className="ce-risk-pill"
          style={{
            color: risk ? SEV_COLOR[risk] : "var(--green)",
            borderColor: risk ? SEV_COLOR[risk] : "var(--green-line)",
          }}
        >
          {risk ? `${risk} risk` : "no findings"}
        </span>
      </div>

      <p className="ce-file-summary">
        {summary ?? "No generated summary available for this file."}
      </p>

      {symbols.length > 0 && (
        <div className="ce-symbols">
          <span className="ce-kicker">Key symbols</span>
          <div className="ce-symbol-row">
            {symbols.slice(0, 8).map((symbol) => (
              <code key={symbol} className="ce-symbol">
                {symbol}
              </code>
            ))}
            {symbols.length > 8 && (
              <span className="ce-symbol-more">+{symbols.length - 8} more</span>
            )}
          </div>
        </div>
      )}

      {findings.length > 0 && (
        <div className="ce-file-foot">
          {findings.length} finding{findings.length > 1 ? "s" : ""} in this file
        </div>
      )}
    </div>
  );
}

/* ─── Finding deep dive ───────────────────────────────────────────────── */

function DeepDive({ finding }: { finding: Finding }) {
  const [open, setOpen] = useState(false);
  const color = SEV_COLOR[finding.severity];

  return (
    <div className={`ce-dive ${open ? "open" : ""}`}>
      <button
        className="ce-dive-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="ce-dive-caret" aria-hidden>
          ▸
        </span>
        <span
          className="ce-dive-sev"
          style={{ color, borderColor: color }}
        >
          {finding.severity}
        </span>
        <span className="ce-dive-title">{finding.issue_title}</span>
        <code className="ce-dive-loc">
          {fileName(finding.file)}:{finding.line}
        </code>
        <span className="ce-dive-toggle">{open ? "Hide" : "Explain More"}</span>
      </button>

      <div className="ce-dive-body">
        <div className="ce-dive-inner">
          <section className="ce-block">
            <span className="ce-kicker">What the code does here</span>
            <p>{finding.explanation}</p>
          </section>

          <section className="ce-block">
            <span className="ce-kicker">Why this is a problem</span>
            <p>
              <strong style={{ color }}>{finding.severity.toUpperCase()}</strong>{" "}
              — {SEV_MEANING[finding.severity]}
            </p>
          </section>

          <section className="ce-block">
            <span className="ce-kicker">How to fix it</span>
            <ol className="ce-steps">
              <li>
                Open <code>{finding.file}</code> and go to line{" "}
                <code>{finding.line}</code>.
              </li>
              <li>{finding.fix_suggestion}</li>
              <li>
                Re-run the review to confirm the finding is gone, and add a test
                covering the affected path.
              </li>
            </ol>
          </section>

          <section className="ce-block">
            <span className="ce-kicker">Change outline</span>
            <div className="ce-diff">
              <div className="ce-diff-row before">
                <span className="ce-diff-mark">-</span>
                <code>
                  {finding.file}:{finding.line} — {finding.issue_title}
                </code>
              </div>
              <div className="ce-diff-row after">
                <span className="ce-diff-mark">+</span>
                <code>{finding.fix_suggestion}</code>
              </div>
            </div>
          </section>

          <div className="ce-dive-meta">
            <span>
              Agent: <strong>{finding.agent}</strong>
            </span>
            <span>
              Confidence: <strong>{Math.round(finding.confidence * 100)}%</strong>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Root ────────────────────────────────────────────────────────────── */

export function CodeExplainer({ data }: { data: ReviewResponse }) {
  const findingsByFile = useMemo(() => {
    const map: Record<string, Finding[]> = {};
    for (const finding of data.findings) {
      (map[finding.file] ??= []).push(finding);
    }
    return map;
  }, [data.findings]);

  const health = useMemo(
    () => computeHealth(data.findings, data.reviewed_files.length),
    [data.findings, data.reviewed_files.length],
  );

  const summaries = data.file_summaries ?? {};
  const symbolsByFile = data.file_symbols ?? {};

  // Explained files first (they have LLM context), then files that produced findings.
  const files = useMemo(() => {
    const ordered = new Set<string>(Object.keys(summaries));
    Object.keys(findingsByFile)
      .sort(
        (a, b) =>
          (findingsByFile[b]?.length ?? 0) - (findingsByFile[a]?.length ?? 0),
      )
      .forEach((path) => ordered.add(path));
    return [...ordered].slice(0, 12);
  }, [summaries, findingsByFile]);

  const sortedFindings = useMemo(
    () =>
      [...data.findings].sort(
        (a, b) =>
          SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) ||
          b.confidence - a.confidence,
      ),
    [data.findings],
  );

  return (
    <section className="grid ce-root" style={{ gap: 16 }}>
      <HealthCard
        data={data}
        health={health}
        fileCount={data.reviewed_files.length}
      />

      {data.summary && (
        <div className="card">
          <span className="ce-kicker">What the reviewer concluded</span>
          <p className="ce-prose">{data.summary}</p>
        </div>
      )}

      {files.length > 0 && (
        <div className="card">
          <div className="ce-section-head">
            <h3>File Guide</h3>
            <p>What each reviewed file is responsible for, in plain English.</p>
          </div>
          <div className="ce-file-grid">
            {files.map((path) => (
              <FileCard
                key={path}
                path={path}
                summary={summaries[path]}
                findings={findingsByFile[path] ?? []}
                symbols={symbolsByFile[path] ?? []}
              />
            ))}
          </div>
        </div>
      )}

      <div className="card">
        <div className="ce-section-head">
          <h3>
            Finding Deep-Dives
            <span className="tab-count" style={{ marginLeft: 8 }}>
              {sortedFindings.length}
            </span>
          </h3>
          <p>Expand any finding for the full explanation and fix walkthrough.</p>
        </div>

        {sortedFindings.length === 0 ? (
          <div className="ce-empty">
            Nothing to explain — this review produced no high-confidence findings.
          </div>
        ) : (
          <div className="ce-dive-list">
            {sortedFindings.map((finding, index) => (
              <DeepDive
                key={`${finding.file}-${finding.line}-${index}`}
                finding={finding}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
