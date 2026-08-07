"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

import "./landing.css";

gsap.registerPlugin(ScrollTrigger);

/* ── Content ──────────────────────────────────────────────────────────── */

/** Installs ARGUS on a repository so pull requests are reviewed automatically. */
const GITHUB_APP_URL = "https://github.com/apps/argus-onewin";

const SPEC = [
  { k: "Agents", v: "06 parallel" },
  { k: "Surfaces", v: "Review · Docs · Graph" },
  { k: "Input", v: "Repo URL / ZIP" },
];

/** Diff sample. Deliberately mundane code — the point is what ARGUS notices. */
const SCAN_LINES = [
  { n: "41", t: "async def create_session(user_id: str, raw: str):", k: "" },
  { n: "42", t: "    query = f\"SELECT * FROM users WHERE id = '{user_id}'\"", k: "del" },
  { n: "43", t: "    query = \"SELECT * FROM users WHERE id = %s\"", k: "add" },
  { n: "44", t: "    row = await db.fetch(query, user_id)", k: "add" },
  { n: "45", t: "    token = hashlib.md5(raw.encode()).hexdigest()", k: "del" },
  { n: "46", t: "    token = secrets.token_urlsafe(32)", k: "add" },
  { n: "47", t: "    return Session(user=row, token=token)", k: "" },
];

const FINDINGS = [
  {
    sev: "critical",
    cls: "crit",
    path: "api/sessions.py:42",
    title: "Interpolated identifier reaches the query builder",
    body: "The user identifier is formatted directly into SQL. Any caller controlling that value controls the statement. Parameterise the query and let the driver bind the value.",
  },
  {
    sev: "high",
    cls: "high",
    path: "api/sessions.py:45",
    title: "Session token derived from an unsuitable digest",
    body: "MD5 is fast and collision-prone, which is the opposite of what a session token needs. Generate tokens from a CSPRNG instead of hashing user input.",
  },
  {
    sev: "clean",
    cls: "pass",
    path: "api/deps.py",
    title: "No findings above the confidence floor",
    body: "Six agents reported nothing actionable here. ARGUS suppresses low-confidence noise rather than padding the report — an empty section is a real result.",
  },
];

const AGENTS = [
  { n: "01", name: "Security", tag: "Injection · Secrets", desc: "Hardcoded credentials, injection paths, unsafe execution, weak crypto and auth handling." },
  { n: "02", name: "Bug & Safety", tag: "Correctness", desc: "Swallowed exceptions, unhandled null paths, dynamic evaluation and silent failure modes." },
  { n: "03", name: "Performance", tag: "Hot paths", desc: "Repeated I/O inside loops, avoidable full scans, and nested iteration over large inputs." },
  { n: "04", name: "Architecture", tag: "Boundaries", desc: "God files, tangled layering, and business logic leaking into transport or UI code." },
  { n: "05", name: "Readability", tag: "Maintainability", desc: "Undocumented non-trivial functions, misleading names, and control flow that blocks review." },
  { n: "06", name: "Accessibility", tag: "Interface", desc: "Missing alternative text, non-semantic interactive elements, and keyboard traps in markup." },
];

const STEPS = [
  { n: "01", h: "Point at a repository", p: "A GitHub URL or a ZIP upload. ARGUS pulls a snapshot, parses every supported source file, and indexes it for retrieval. Nothing is installed and no OAuth dance is required." },
  { n: "02", h: "Route before spending", p: "The change is classified first. A documentation-only edit skips the language models entirely; a small diff takes a single compact pass. Work is only sent to an agent that can act on it." },
  { n: "03", h: "Run agents in parallel", p: "Selected agents execute concurrently rather than in sequence, alongside structure analysis and file summarisation. One slow agent no longer holds the others hostage." },
  { n: "04", h: "Read the report", p: "Findings are deduplicated, ranked by severity and confidence, then written in the register of the persona you chose — from a first-week intern to a production backend engineer." },
];

const OUTPUTS = [
  { k: "Surface 01", h: "Review", p: "Ranked findings grouped by file, each with evidence, a severity, a confidence score, and the agent that raised it." },
  { k: "Surface 02", h: "Code Explainer", p: "A plain-English health score, per-file summaries, and expandable walkthroughs for anyone who does not already know the codebase." },
  { k: "Surface 03", h: "Documentation", p: "README, per-module documentation, docstrings, and an onboarding guide generated from the parsed source rather than guessed." },
  { k: "Surface 04", h: "Dependency graph", p: "A force-directed map of how modules actually import one another. Drag nodes, isolate a layer, and trace a file's neighbourhood." },
];

/* ── Scramble device ──────────────────────────────────────────────────── */

const GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/<>[]{}()=+*#@$%&_-";

/**
 * Resolve an element's text from noise to its real value.
 *
 * The visual metaphor for the whole product: unreadable input becoming legible
 * output. Runs once per element, on scroll entry.
 */
function decode(el: HTMLElement, duration = 900) {
  const final = el.dataset.text ?? el.textContent ?? "";
  const start = performance.now();
  let frame = 0;

  const tick = (now: number) => {
    const progress = Math.min(1, (now - start) / duration);
    // Ease-out so the last characters settle rather than snap.
    const settled = Math.floor(final.length * (1 - Math.pow(1 - progress, 3)));
    let out = final.slice(0, settled);
    for (let i = settled; i < final.length; i += 1) {
      out += final[i] === " " ? " " : GLYPHS[(frame + i * 7) % GLYPHS.length];
    }
    el.textContent = out;
    frame += 1;
    if (progress < 1) requestAnimationFrame(tick);
    else el.textContent = final;
  };
  requestAnimationFrame(tick);
}

/* ── Page ─────────────────────────────────────────────────────────────── */

export default function HomePage() {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const scope = root.current;
    if (!scope) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) return;

    let ctx: gsap.Context | null = null;

    const build = () => {
      ctx = buildTimeline(scope);
    };

    // Browsers pause requestAnimationFrame in background tabs, which would strand
    // every gsap.from() at its start value — a hero that is simply never drawn for
    // anyone who opens the page in a new tab. Wait until the page is actually seen.
    if (document.visibilityState === "visible") {
      build();
      return () => ctx?.revert();
    }

    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      document.removeEventListener("visibilitychange", onVisible);
      build();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      ctx?.revert();
    };
  }, []);

  return (
    <div className="lp" ref={root}>
      <PageBody />
    </div>
  );
}

/** All scroll choreography. Split out so the effect above stays readable. */
function buildTimeline(scope: HTMLElement) {
  return gsap.context(() => {
      /* Hero — masked lines rise in sequence. */
      gsap.from("[data-hero-line] > span", {
        yPercent: 108,
        duration: 1.15,
        ease: "power4.out",
        stagger: 0.09,
        delay: 0.12,
      });

      gsap.from("[data-hero-fade]", {
        opacity: 0,
        y: 22,
        duration: 0.85,
        ease: "power3.out",
        stagger: 0.1,
        delay: 0.55,
      });

      /* Generic fade-up for anything marked as a reveal. */
      gsap.utils.toArray<HTMLElement>("[data-reveal]").forEach((el) => {
        gsap.from(el, {
          opacity: 0,
          y: 30,
          duration: 0.8,
          ease: "power3.out",
          scrollTrigger: { trigger: el, start: "top 88%", once: true },
        });
      });

      /* Row groups stagger as the group enters. */
      gsap.utils.toArray<HTMLElement>("[data-stagger]").forEach((group) => {
        gsap.from(group.children, {
          opacity: 0,
          y: 24,
          duration: 0.65,
          ease: "power3.out",
          stagger: 0.07,
          scrollTrigger: { trigger: group, start: "top 85%", once: true },
        });
      });

      /* Section headings wipe up from a mask. */
      gsap.utils.toArray<HTMLElement>("[data-mask] > span").forEach((line) => {
        gsap.from(line, {
          yPercent: 105,
          duration: 1,
          ease: "power4.out",
          scrollTrigger: { trigger: line, start: "top 92%", once: true },
        });
      });

      /* Decode: scramble on entry, then resolve. */
      gsap.utils.toArray<HTMLElement>("[data-decode]").forEach((el, i) => {
        el.dataset.text = el.textContent ?? "";
        ScrollTrigger.create({
          trigger: el,
          start: "top 92%",
          once: true,
          onEnter: () => window.setTimeout(() => decode(el), i * 55),
        });
      });

      /* Diff rows sweep in as the scan panel is read. */
      gsap.from("[data-scan] .lp-scan-line", {
        opacity: 0,
        x: -14,
        duration: 0.45,
        ease: "power2.out",
        stagger: 0.06,
        scrollTrigger: { trigger: "[data-scan]", start: "top 80%", once: true },
      });

      /* Closing wordmark drifts slightly against the scroll. */
      gsap.to("[data-mark]", {
        yPercent: -8,
        ease: "none",
        scrollTrigger: {
          trigger: "[data-mark]",
          start: "top bottom",
          end: "bottom bottom",
          scrub: 0.6,
        },
      });
  }, scope);
}

/** Static markup. Motion is attached by buildTimeline via data-attributes. */
function PageBody() {
  return (
    <>
      {/* ── Nav ── */}
      <nav className="lp-nav">
        <Link href="/" className="lp-wordmark">
          <span className="lp-eye" aria-hidden />
          ARGUS
        </Link>
        <span className="lp-nav-spacer" />
        <div className="lp-nav-links">
          <a href="#agents" className="lp-nav-link hide-sm">Agents</a>
          <a href="#pipeline" className="lp-nav-link hide-sm">Pipeline</a>
          <a href="#output" className="lp-nav-link hide-sm">Output</a>
          <Link href="/dashboard" className="btn btn-sm" id="lp-nav-cta">
            Open Dashboard
          </Link>
        </div>
      </nav>

      {/* ── Hero ── */}
      <header className="shell lp-hero">
        <span className="lp-hero-eyebrow" data-decode>
          Autonomous Review for GitHub Understanding &amp; Security
        </span>

        <h1 className="display">
          <span className="lp-mask" data-hero-line><span>A hundred eyes</span></span>
          <span className="lp-mask" data-hero-line><span>on every <em className="serif">commit</em>.</span></span>
        </h1>

        <div className="lp-hero-foot">
          <div>
            <p className="lede" data-hero-fade>
              ARGUS reads a repository the way a senior engineer would. Six specialised
              agents run in parallel to produce security findings, review comments, and
              documentation grounded in the code that is actually there.
            </p>
            <div className="lp-cta-row" data-hero-fade>
              <Link href="/dashboard" className="btn" id="lp-hero-cta">
                Run an analysis
              </Link>
              <a
                href={GITHUB_APP_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-secondary"
                id="lp-hero-app-cta"
              >
                Download the GitHub App
              </a>
              <a href="#pipeline" className="btn btn-secondary" id="lp-how-cta">
                How it works
              </a>
            </div>
          </div>

          <dl className="lp-spec" data-hero-fade>
            {SPEC.map((s) => (
              <div key={s.k}>
                <dt>{s.k}</dt>
                <dd>{s.v}</dd>
              </div>
            ))}
          </dl>
        </div>
      </header>

      {/* ── 01 · The read ── */}
      <section className="lp-section tinted">
        <div className="shell">
          <div className="sec-mark" data-reveal>
            <span className="sec-mark-num">01</span>
            <span className="sec-mark-line" />
            <span className="sec-mark-name">The read</span>
          </div>

          <div className="lp-split">
            <div className="lp-split-sticky">
              <h2 className="h2" data-mask>
                <span>Most review tools</span>
              </h2>
              <h2 className="h2" data-mask>
                <span>skim. ARGUS <em className="serif">reads</em>.</span>
              </h2>
            </div>

            <div className="lp-body" data-reveal>
              <p>
                A diff on its own is not enough context to judge a change. ARGUS parses the
                whole snapshot first — every function, class and import — then indexes it so
                each agent can retrieve the code that matters to <strong>its</strong> question
                rather than reading the same oversized blob.
              </p>
              <p>
                That context is what separates a real finding from a guess. Every item in the
                report cites a file and a line, carries a confidence score, and names the agent
                that raised it. Anything below the confidence floor is discarded rather than
                shipped as filler.
              </p>

              <div className="lp-scan" data-scan>
                <div className="lp-scan-bar">
                  <span className="lp-scan-dot" />
                  api/sessions.py · reviewed
                </div>
                <div className="lp-scan-body">
                  {SCAN_LINES.map((l) => (
                    <div key={l.n} className={`lp-scan-line ${l.k}`}>
                      <span className="lp-scan-num">{l.n}</span>
                      <span>{l.t}</span>
                    </div>
                  ))}
                </div>
                <div className="lp-scan-foot">
                  <span>2 replaced</span>
                  <span>1 critical</span>
                  <span>1 high</span>
                  <span style={{ marginLeft: "auto" }}>6 agents</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── 02 · Findings ── */}
      <section className="lp-section">
        <div className="shell">
          <div className="sec-mark" data-reveal>
            <span className="sec-mark-num">02</span>
            <span className="sec-mark-line" />
            <span className="sec-mark-name">Findings</span>
          </div>

          <h2 className="h2" style={{ marginBottom: "clamp(28px,4vw,52px)" }} data-mask>
            <span>Evidence, not <em className="serif">opinion</em>.</span>
          </h2>

          <div className="lp-ledger" data-stagger>
            {FINDINGS.map((f) => (
              <article className="lp-finding" key={f.path}>
                <span className={`lp-finding-sev ${f.cls}`}>{f.sev}</span>
                <span className="lp-finding-path">{f.path}</span>
                <div className="lp-finding-body">
                  <h3>{f.title}</h3>
                  <p>{f.body}</p>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ── 03 · Agents ── */}
      <section className="lp-section tinted" id="agents">
        <div className="shell">
          <div className="sec-mark" data-reveal>
            <span className="sec-mark-num">03</span>
            <span className="sec-mark-line" />
            <span className="sec-mark-name">The roster</span>
          </div>

          <h2 className="h2" style={{ marginBottom: "clamp(28px,4vw,52px)" }} data-mask>
            <span>Six specialists, one <em className="serif">pass</em>.</span>
          </h2>

          <div className="lp-roster" data-stagger>
            {AGENTS.map((a) => (
              <article className="lp-agent" key={a.n}>
                <span className="lp-agent-idx">{a.n}</span>
                <span className="lp-agent-name">{a.name}</span>
                <span className="lp-agent-desc">{a.desc}</span>
                <span className="lp-agent-tag">{a.tag}</span>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ── 04 · Pipeline ── */}
      <section className="lp-section" id="pipeline">
        <div className="shell">
          <div className="sec-mark" data-reveal>
            <span className="sec-mark-num">04</span>
            <span className="sec-mark-line" />
            <span className="sec-mark-name">Pipeline</span>
          </div>

          <div className="lp-split">
            <div className="lp-split-sticky">
              <h2 className="h2" data-mask>
                <span>Four moves,</span>
              </h2>
              <h2 className="h2" data-mask>
                <span>no <em className="serif">waiting</em>.</span>
              </h2>
              <p className="lede" style={{ marginTop: 22 }} data-reveal>
                The expensive part of review is not thinking — it is queueing. ARGUS decides
                what deserves a model call before making one.
              </p>
            </div>

            <div className="lp-steps" data-stagger>
              {STEPS.map((s) => (
                <article className="lp-step" key={s.n}>
                  <span className="lp-step-n">{s.n}</span>
                  <div>
                    <h3>{s.h}</h3>
                    <p>{s.p}</p>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── 05 · Output ── */}
      <section className="lp-section tinted" id="output">
        <div className="shell">
          <div className="sec-mark" data-reveal>
            <span className="sec-mark-num">05</span>
            <span className="sec-mark-line" />
            <span className="sec-mark-name">Output</span>
          </div>

          <h2 className="h2" style={{ marginBottom: "clamp(28px,4vw,52px)" }} data-mask>
            <span>Four surfaces, one <em className="serif">run</em>.</span>
          </h2>

          <div className="lp-outputs" data-stagger>
            {OUTPUTS.map((o) => (
              <article className="lp-output" key={o.h}>
                <span className="lp-output-k">{o.k}</span>
                <h3>{o.h}</h3>
                <p>{o.p}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ── Close ── */}
      <section className="lp-close">
        <div className="shell">
          <h2 className="h2" data-reveal>
            Point it at a repository and <em className="serif">read the report</em>.
          </h2>
          <div className="lp-cta-row" data-reveal>
            <Link href="/dashboard" className="btn" id="lp-footer-cta">
              Open the dashboard
            </Link>
            <a
              href={GITHUB_APP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-secondary"
              id="lp-footer-app-cta"
            >
              Download the GitHub App
            </a>
          </div>
        </div>
      </section>

      {/* ── Wordmark ── */}
      <div className="shell lp-mark">
        <p className="lp-mark-text" data-mark>ARGUS</p>
      </div>

      <footer className="shell lp-footer">
        <span>Autonomous Review for GitHub Understanding &amp; Security</span>
        <span>Multi-agent code intelligence</span>
      </footer>
    </>
  );
}
