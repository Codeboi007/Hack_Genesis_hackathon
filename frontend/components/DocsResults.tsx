"use client";

import { DocsResponse } from "@/lib/types";

/* ─── Minimal markdown → HTML renderer (no deps) ──────── */
function renderMarkdown(md: string): string {
  let html = md
    // Fenced code blocks
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
      const escaped = code.replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return `<pre><code class="lang-${lang}">${escaped}</code></pre>`;
    })
    // Headings
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    // Bold / italic
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/_(.+?)_/g, "<em>$1</em>")
    // Inline code
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    // Blockquote
    .replace(/^> (.+)$/gm, "<blockquote>$1</blockquote>")
    // Horizontal rule
    .replace(/^---$/gm, "<hr>")
    // Unordered list items
    .replace(/^\s*[-*] (.+)$/gm, "<li>$1</li>")
    // Ordered list items
    .replace(/^\s*\d+\. (.+)$/gm, "<li>$1</li>")
    // Links
    .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    // Paragraphs — blank lines
    .replace(/\n\n+/g, "\n\n");

  // Wrap consecutive <li> in <ul>
  html = html.replace(/((<li>.*?<\/li>\n?)+)/gs, "<ul>$1</ul>");

  // Paragraphs
  const lines = html.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^<(h[1-3]|ul|ol|li|pre|blockquote|hr)/.test(trimmed)) {
      out.push(trimmed);
    } else {
      out.push(`<p>${trimmed}</p>`);
    }
  }
  return out.join("\n");
}

/* ─── Rendered markdown block ──────────────────────────── */
function MarkdownBlock({ content }: { content: string }) {
  return (
    <div
      className="md-render scroll-box"
      style={{ maxHeight: 520, padding: "4px 0" }}
      dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
    />
  );
}

/* ─── Collapsible file section ─────────────────────────── */
function FileSection({ path, content, renderAsMarkdown = false }: {
  path: string;
  content: string;
  renderAsMarkdown?: boolean;
}) {
  return (
    <details>
      <summary>
        {path}
        <span
          style={{
            marginLeft: "auto",
            fontSize: 10.5,
            color: "var(--ink-3)",
            fontWeight: 400,
            letterSpacing: "0.06em",
          }}
        >
          {content.split("\n").length} lines
        </span>
      </summary>
      <div className="detail-body">
        {renderAsMarkdown ? (
          <MarkdownBlock content={content} />
        ) : (
          <pre>{content}</pre>
        )}
      </div>
    </details>
  );
}

/* ─── Main component ───────────────────────────────────── */
export function DocsResults({ data }: { data: DocsResponse }) {
  const modularDocs = data.modular_docs ?? {};
  const docstrings = data.docstrings ?? {};
  const readme = data.readme ?? "README content is unavailable for this run.";
  const onboardingGuide = data.onboarding_guide ?? "Onboarding guide is unavailable for this run.";

  return (
    <section className="grid" style={{ gap: 16 }}>

      {/* ── Status banner ── */}
      <div className="card" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 14 }}>
        <div>
          <span className="ce-kicker">Documentation generated</span>
          <p style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 12, color: "var(--ink-2)" }}>
            {data.persona}
            {" · "}
            {Object.keys(modularDocs).length} modules
            {" · "}
            {Object.keys(docstrings).length} files with docstrings
          </p>
        </div>
        {data.doc_rot_detected && (
          <div className="doc-rot-banner">
            Doc rot detected — README regenerated
          </div>
        )}
      </div>

      {/* ── README ── */}
      <div className="card">
        <div className="ce-section-head">
          <h3>README</h3>
          <p>Written from parsed symbols and structure, not guessed from the repository name.</p>
        </div>
        <MarkdownBlock content={readme} />
      </div>

      {/* ── Onboarding guide ── */}
      <div className="card">
        <div className="ce-section-head">
          <h3>Onboarding guide</h3>
          <p>The path a new engineer should read this codebase in.</p>
        </div>
        <div className="card-inset">
          <MarkdownBlock content={onboardingGuide} />
        </div>
      </div>

      {/* ── Modular docs ── */}
      {Object.keys(modularDocs).length > 0 && (
        <div className="card">
          <div className="ce-section-head">
            <h3>
              Module documentation
              <span className="tab-count" style={{ marginLeft: 10 }}>
                {Object.keys(modularDocs).length}
              </span>
            </h3>
            <p>One entry per module, with its symbols, imports and suggested reading order.</p>
          </div>
          <div style={{ display: "grid", gap: 6 }}>
            {Object.entries(modularDocs).map(([path, content]) => (
              <FileSection key={path} path={path} content={content} renderAsMarkdown />
            ))}
          </div>
        </div>
      )}

      {/* ── Docstrings ── */}
      {Object.keys(docstrings).length > 0 && (
        <div className="card">
          <div className="ce-section-head">
            <h3>
              Generated docstrings
              <span className="tab-count" style={{ marginLeft: 10 }}>
                {Object.keys(docstrings).length}
              </span>
            </h3>
            <p>Drop-in docstrings for every parsed function, keyed by file.</p>
          </div>
          <div style={{ display: "grid", gap: 6 }}>
            {Object.entries(docstrings).map(([path, content]) => (
              <FileSection key={path} path={path} content={content} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
