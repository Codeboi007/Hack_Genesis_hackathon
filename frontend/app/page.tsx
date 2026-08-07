"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useRef } from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

const FaultyTerminal = dynamic(() => import("./components/FaultyTerminal"), {
  ssr: false,
});

gsap.registerPlugin(ScrollTrigger);

/* ── Palette ─────────────────────────────────────────────── */
// Mint green terminal theme derived from FaultyTerminal tint #A7EF9E
const C = {
  bg: "#050d05",
  bg2: "#0a160a",
  card: "#0d1a0d",
  border: "#1a3a1a",
  border2: "#122012",
  mint: "#A7EF9E",
  mintDim: "#6bc462",
  cyan: "#5ef8d0",
  amber: "#f0c040",
  red: "#ff5f5f",
  text: "#d4f0d4",
  muted: "#6a9a6a",
} as const;

/* ── Data ────────────────────────────────────────────────── */
const ISSUES = [
  { sev: "CRIT", color: C.red, bg: "rgba(255,95,95,0.10)", file: "db/queries.ts:47", msg: "SQL Injection — raw string in query builder" },
  { sev: "WARN", color: C.amber, bg: "rgba(240,192,64,0.09)", file: "api/upload.ts:12", msg: "Missing file-size & MIME validation — DoS risk" },
  { sev: "PERF", color: C.cyan, bg: "rgba(94,248,208,0.07)", file: "hooks/useData.ts:88", msg: "N+1 query inside render loop — add useMemo" },
];

const FEATURES = [
  { icon: "🔬", color: C.red, title: "Security Review", desc: "Detects injections, secrets exposure, auth flaws and 50+ vulnerability patterns before merge." },
  { icon: "📡", color: C.mint, title: "Auto Docs", desc: "Generates README, docstrings, onboarding guides and dependency graphs from your source." },
  { icon: "🧠", color: C.cyan, title: "Persona-Aware", desc: "Adapts depth and tone per reviewer role — intern, senior engineer, or architect." },
  { icon: "⚡", color: C.amber, title: "Parallel Agents", desc: "Six specialised agents fire concurrently. Results in under 2 seconds on any PR." },
  { icon: "🗺️", color: C.mintDim, title: "Graph Visuals", desc: "Interactive dependency graphs rendered from live codebase structure analysis." },
  { icon: "🔄", color: C.cyan, title: "PR Integration", desc: "Posts inline comments directly on GitHub Pull Requests with zero manual steps." },
];

const STEPS = [
  { n: "01", label: "Connect Repo", desc: "Paste your GitHub repo URL. No OAuth, no permissions dance." },
  { n: "02", label: "Select PR", desc: "Point to any pull request or paste raw code directly." },
  { n: "03", label: "Agents Fire", desc: "Six AI agents analyse in parallel — security, perf, docs, style, a11y, architecture." },
  { n: "04", label: "Instant Results", desc: "Get inline findings, docs, and graphs in under 2 seconds." },
];

/* ── Page ────────────────────────────────────────────────── */
export default function HomePage() {
  const heroRef = useRef<HTMLDivElement>(null);
  const demoRef = useRef<HTMLDivElement>(null);
  const featRef = useRef<HTMLElement>(null);
  const stepsRef = useRef<HTMLElement>(null);

  useEffect(() => {
    /* Hero stagger */
    if (heroRef.current) {
      gsap.fromTo(Array.from(heroRef.current.children),
        { opacity: 0, y: 40 },
        { opacity: 1, y: 0, stagger: 0.12, duration: 0.85, ease: "power3.out", delay: 0.3 }
      );
    }
    /* Demo */
    if (demoRef.current) {
      gsap.fromTo(demoRef.current,
        { opacity: 0, y: 40 },
        {
          opacity: 1, y: 0, duration: 0.7, ease: "power3.out",
          scrollTrigger: { trigger: demoRef.current, start: "top 82%" }
        });
      gsap.fromTo(demoRef.current.querySelectorAll(".irow"),
        { opacity: 0, x: -18 },
        {
          opacity: 1, x: 0, stagger: 0.13, duration: 0.45, ease: "power2.out",
          scrollTrigger: { trigger: demoRef.current, start: "top 76%" }
        });
    }
    /* Features */
    if (featRef.current) {
      gsap.fromTo(featRef.current.querySelectorAll(".fc"),
        { opacity: 0, y: 44, scale: 0.95 },
        {
          opacity: 1, y: 0, scale: 1, stagger: 0.1, duration: 0.55, ease: "power3.out",
          scrollTrigger: { trigger: featRef.current, start: "top 84%" }
        });
    }
    /* Steps */
    if (stepsRef.current) {
      gsap.fromTo(stepsRef.current.querySelectorAll(".step"),
        { opacity: 0, x: -30 },
        {
          opacity: 1, x: 0, stagger: 0.15, duration: 0.6, ease: "power3.out",
          scrollTrigger: { trigger: stepsRef.current, start: "top 84%" }
        });
    }
    return () => ScrollTrigger.getAll().forEach((trigger) => trigger.kill());
  }, []);

  return (
    <>
      <style>{`
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        html { scroll-behavior: smooth; }
        body {
          background: ${C.bg};
          color: ${C.text};
          font-family: 'Space Grotesk', system-ui, sans-serif;
          overflow-x: hidden;
          -webkit-font-smoothing: antialiased;
        }
        a { color: inherit; text-decoration: none; }

        @keyframes mintpulse {
          0%,100% { box-shadow: 0 0 16px ${C.mint}44; }
          50%      { box-shadow: 0 0 36px ${C.mint}88, 0 0 72px ${C.mint}22; }
        }
        @keyframes scantick {
          0%   { transform: translateY(-100%); }
          100% { transform: translateY(100vh); }
        }
        @keyframes blink {
          0%,100% { opacity: 1; } 50% { opacity: 0; }
        }
        @keyframes glitch1 {
          0%,89%,100% { transform: none; clip-path: none; }
          90% { transform: translate(-2px,1px); clip-path: polygon(0 15%,100% 15%,100% 35%,0 35%); }
          95% { transform: translate(2px,-1px); clip-path: polygon(0 60%,100% 60%,100% 80%,0 80%); }
        }
        @keyframes glitch2 {
          0%,89%,100% { transform: none; clip-path: none; }
          90% { transform: translate(2px,-1px); clip-path: polygon(0 55%,100% 55%,100% 75%,0 75%); }
          95% { transform: translate(-2px,1px); clip-path: polygon(0 10%,100% 10%,100% 30%,0 30%); }
        }

        .glitch-wrap { position: relative; display: inline-block; }
        .glitch-wrap::before, .glitch-wrap::after {
          content: attr(data-text);
          position: absolute; top: 0; left: 0; width: 100%;
          background: inherit; -webkit-background-clip: text;
          -webkit-text-fill-color: transparent; background-clip: text;
        }
        .glitch-wrap::before { color: ${C.red};  animation: glitch1 4s infinite; }
        .glitch-wrap::after  { color: ${C.cyan}; animation: glitch2 4s infinite 0.15s; }

        .mint-btn {
          display: inline-flex; align-items: center; gap: 8px;
          padding: 14px 32px; border: 1.5px solid ${C.mint};
          border-radius: 4px; font-weight: 700; font-size: 15px;
          color: ${C.mint}; background: transparent; cursor: pointer;
          letter-spacing: .04em; transition: all 0.2s;
          animation: mintpulse 2.8s ease infinite;
          font-family: 'Space Grotesk', sans-serif;
        }
        .mint-btn:hover {
          background: ${C.mint}18; transform: scale(1.05);
          box-shadow: 0 0 48px ${C.mint}55;
        }
        .ghost-btn {
          display: inline-flex; align-items: center; gap: 8px;
          padding: 14px 28px; border: 1.5px solid ${C.border};
          border-radius: 4px; font-size: 15px; font-weight: 600;
          color: ${C.muted}; background: transparent; cursor: pointer;
          transition: all 0.2s; font-family: 'Space Grotesk', sans-serif;
        }
        .ghost-btn:hover { border-color: ${C.mint}; color: ${C.mint}; box-shadow: 0 0 18px ${C.mint}22; }

        .fc {
          background: ${C.card};
          border: 1px solid ${C.border};
          border-radius: 10px; padding: 28px; cursor: default;
          transition: transform .25s, box-shadow .25s, border-color .25s;
        }
        .fc:hover { transform: translateY(-7px); }

        .irow {
          display: flex; align-items: flex-start; gap: 12px;
          padding: 12px 20px; border-bottom: 1px solid ${C.border2};
          font-family: 'JetBrains Mono', monospace; font-size: 12.5px;
        }
        .irow:last-child { border-bottom: none; }

        .step {
          display: flex; gap: 20px; align-items: flex-start;
          padding: 24px 0; border-bottom: 1px solid ${C.border2};
        }
        .step:last-child { border-bottom: none; }
      `}</style>

      {/* ── Scanline overlay ── */}
      <div aria-hidden style={{
        position: "fixed", inset: 0, zIndex: 1, pointerEvents: "none",
        background: `repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,0.035) 2px,rgba(0,0,0,0.035) 4px)`
      }} />
      <div aria-hidden style={{
        position: "fixed", top: 0, left: 0, right: 0, height: 2, zIndex: 2,
        pointerEvents: "none", opacity: 0.3,
        background: `linear-gradient(90deg,transparent,${C.mint}55,transparent)`,
        animation: "scantick 7s linear infinite"
      }} />

      {/* ══════ NAV ══════ */}
      <nav style={{
        position: "sticky", top: 0, zIndex: 100,
        display: "flex", alignItems: "center",
        padding: "14px 32px",
        backdropFilter: "blur(16px)",
        background: `rgba(5,13,5,0.85)`,
        borderBottom: `1px solid ${C.border}`
      }}>
        <span style={{
          display: "inline-flex", alignItems: "center", gap: 8,
          fontWeight: 800, fontSize: 18, letterSpacing: ".04em",
          fontFamily: "'JetBrains Mono',monospace",
          color: C.mint,
          textShadow: `0 0 16px ${C.mint}88`
        }}>
          <img
            src="/icon.svg"
            alt="Cypher AI logo"
            width={18}
            height={18}
            style={{ display: "block" }}
          />
          Cypher<span style={{ color: C.muted }}>AI</span>
        </span>
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <a href="#features" className="ghost-btn" style={{ padding: "8px 18px", fontSize: 13 }}>Features</a>
          <Link href="/dashboard" className="mint-btn" style={{ padding: "9px 22px", fontSize: 13, animation: "none" }}>
            Open Dashboard →
          </Link>
        </div>
      </nav>

      {/* ══════ HERO ══════ */}
      <section style={{ position: "relative", zIndex: 2, overflow: "hidden" }}>
        {/* FaultyTerminal background */}
        <div style={{ position: "absolute", inset: 0, zIndex: 0 }}>
          <FaultyTerminal
            scale={1.5}
            gridMul={[2, 1]}
            digitSize={1.2}
            timeScale={0.5}
            scanlineIntensity={0.5}
            glitchAmount={1}
            flickerAmount={1}
            noiseAmp={1}
            chromaticAberration={0}
            dither={0}
            curvature={0.1}
            tint="#A7EF9E"
            mouseReact
            mouseStrength={0.5}
            pageLoadAnimation
            brightness={0.6}
            style={{ opacity: 0.55 }}
          />
          {/* Dark gradient over terminal so text is readable */}
          <div style={{
            position: "absolute", inset: 0,
            background: `linear-gradient(to bottom, rgba(5,13,5,0.55) 0%, rgba(5,13,5,0.3) 50%, rgba(5,13,5,0.92) 100%)`
          }} />
        </div>

        {/* Hero content */}
        <div ref={heroRef} style={{
          position: "relative", zIndex: 2,
          maxWidth: 900, margin: "0 auto",
          padding: "140px 32px 120px",
          display: "flex", flexDirection: "column", alignItems: "flex-start"
        }}>
          {/* Badge */}
          <div style={{
            display: "inline-flex", alignItems: "center", gap: 8,
            padding: "5px 14px",
            border: `1px solid ${C.mint}44`,
            borderRadius: 999, fontSize: 11, fontWeight: 700,
            color: C.mint, marginBottom: 28,
            letterSpacing: ".08em", textTransform: "uppercase",
            background: `rgba(167,239,158,0.08)`,
            fontFamily: "'JetBrains Mono',monospace"
          }}>
            <span style={{
              width: 7, height: 7, borderRadius: "50%", background: C.mint,
              boxShadow: `0 0 8px ${C.mint}`, display: "inline-block",
              animation: "blink 1.4s ease infinite"
            }} />
            Multi-Agent AI · v2.0 · Now Live
          </div>

          {/* Headline */}
          <h1
            data-text="AI That Understands Your Codebase"
            className="glitch-wrap"
            style={{
              fontSize: "clamp(2.6rem,5.5vw,4.4rem)",
              fontWeight: 800, lineHeight: 1.06,
              letterSpacing: "-0.03em", marginBottom: 22,
              background: `linear-gradient(130deg,#ffffff 0%,${C.text} 35%,${C.mint} 70%,${C.cyan} 100%)`,
              WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text"
            }}
          >
            AI That Understands<br />Your Codebase
          </h1>

          <p style={{
            fontSize: "1.12rem", color: C.muted, lineHeight: 1.75,
            maxWidth: 580, marginBottom: 38
          }}>
            Multi-agent AI for{" "}
            <span style={{ color: C.mint, fontWeight: 600 }}>code review</span>,{" "}
            <span style={{ color: C.cyan, fontWeight: 600 }}>documentation</span>, and{" "}
            <span style={{ color: C.amber, fontWeight: 600 }}>deep code understanding</span>.
            Six specialised agents. One unified pipeline.
          </p>

          {/* CTAs */}
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 40 }}>
            <Link href="/dashboard" className="mint-btn" id="lp-hero-cta">🚀 Open Dashboard</Link>
            <a href="#how" className="ghost-btn" id="lp-how-cta">See How It Works ↓</a>
          </div>

          {/* Agent pills */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {[
              { c: C.red, l: "Security" },
              { c: C.amber, l: "Performance" },
              { c: C.mint, l: "Documentation" },
              { c: C.cyan, l: "Architecture" },
              { c: C.mintDim, l: "Readability" },
              { c: "#bc8cff", l: "Accessibility" },
            ].map(({ c, l }) => (
              <span key={l} style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                padding: "5px 12px",
                background: "rgba(167,239,158,0.04)",
                border: `1px solid ${C.border}`,
                borderRadius: 999, fontSize: 11, fontWeight: 700, color: C.muted,
                fontFamily: "'JetBrains Mono',monospace"
              }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: c, boxShadow: `0 0 5px ${c}` }} />
                {l} Agent
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* ══════ DEMO TERMINAL ══════ */}
      <section style={{ maxWidth: 1000, margin: "0 auto", padding: "80px 32px", position: "relative", zIndex: 2 }}>
        <div style={{ textAlign: "center", marginBottom: 40 }}>
          <h2 style={{
            fontSize: "clamp(1.6rem,3vw,2.4rem)", fontWeight: 800, letterSpacing: "-0.02em",
            background: `linear-gradient(90deg,#fff,${C.mint})`,
            WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text",
            marginBottom: 8
          }}>Live Review Output</h2>
          <p style={{ color: C.muted, fontSize: 14 }}>Real findings caught before merge — zero false negatives.</p>
        </div>

        <div ref={demoRef} style={{
          background: C.bg2, borderRadius: 10, overflow: "hidden",
          border: `1px solid ${C.mint}44`,
          boxShadow: `0 0 60px rgba(167,239,158,0.10), 0 0 0 1px ${C.mint}11`
        }}>
          {/* Chrome */}
          <div style={{
            display: "flex", alignItems: "center", gap: 8,
            padding: "11px 18px", background: C.bg,
            borderBottom: `1px solid ${C.border}`
          }}>
            <span style={{ width: 11, height: 11, borderRadius: "50%", background: "#ff5f5f" }} />
            <span style={{ width: 11, height: 11, borderRadius: "50%", background: "#f4d03f" }} />
            <span style={{ width: 11, height: 11, borderRadius: "50%", background: C.mint }} />
            <span style={{
              fontFamily: "'JetBrains Mono',monospace", fontSize: 12,
              color: C.muted, marginLeft: 8
            }}>Cypher-ai — pr #247 · feature/user-auth</span>
            <span style={{
              marginLeft: "auto", fontFamily: "'JetBrains Mono',monospace",
              fontSize: 10, color: C.mintDim
            }}>● LIVE</span>
          </div>

          {/* Issue rows */}
          {ISSUES.map((iss, i) => (
            <div key={i} className="irow" style={{ background: iss.bg }}>
              <span style={{
                padding: "2px 8px", borderRadius: 4,
                border: `1px solid ${iss.color}55`,
                color: iss.color, fontWeight: 700, fontSize: 10,
                letterSpacing: ".07em", background: `${iss.color}15`,
                flexShrink: 0, marginTop: 1
              }}>{iss.sev}</span>
              <span style={{ color: "#7de8c5", minWidth: 190, flexShrink: 0 }}>{iss.file}</span>
              <span style={{ color: C.text }}>{iss.msg}</span>
            </div>
          ))}

          {/* Footer */}
          <div style={{
            padding: "10px 20px", background: C.bg,
            borderTop: `1px solid ${C.border}`,
            fontFamily: "'JetBrains Mono',monospace", fontSize: 11,
            color: C.muted, display: "flex", gap: 20
          }}>
            <span style={{ color: C.red }}>● 1 critical</span>
            <span style={{ color: C.amber }}>● 1 warning</span>
            <span style={{ color: C.cyan }}>● 1 perf</span>
            <span style={{ marginLeft: "auto" }}>✓ 6 agents · 1.4s</span>
          </div>
        </div>
      </section>

      {/* ══════ HOW IT WORKS ══════ */}
      <section id="how" ref={stepsRef} style={{ maxWidth: 860, margin: "0 auto", padding: "0 32px 80px", zIndex: 2, position: "relative" }}>
        <div style={{ textAlign: "center", marginBottom: 48 }}>
          <h2 style={{
            fontSize: "clamp(1.6rem,3vw,2.4rem)", fontWeight: 800, letterSpacing: "-0.02em",
            background: `linear-gradient(90deg,#fff,${C.cyan})`,
            WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text",
            marginBottom: 8
          }}>How It Works</h2>
          <p style={{ color: C.muted, fontSize: 14 }}>Four steps. Under 5 seconds total.</p>
        </div>
        <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden", background: C.card }}>
          {STEPS.map((s, i) => (
            <div key={i} className="step" style={{ padding: "24px 28px" }}>
              <span style={{
                fontFamily: "'JetBrains Mono',monospace", fontSize: 22,
                fontWeight: 700, color: C.mint, flexShrink: 0, opacity: 0.7
              }}>{s.n}</span>
              <div>
                <div style={{ fontWeight: 700, fontSize: 16, color: C.text, marginBottom: 5 }}>{s.label}</div>
                <div style={{ fontSize: 14, color: C.muted, lineHeight: 1.65 }}>{s.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ══════ FEATURES ══════ */}
      <section id="features" ref={featRef} style={{ maxWidth: 1100, margin: "0 auto", padding: "0 32px 80px", zIndex: 2, position: "relative" }}>
        <div style={{ textAlign: "center", marginBottom: 44 }}>
          <h2 style={{
            fontSize: "clamp(1.6rem,3vw,2.4rem)", fontWeight: 800, letterSpacing: "-0.02em",
            background: `linear-gradient(90deg,#fff,${C.mintDim})`,
            WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text",
            marginBottom: 8
          }}>Engineered for Speed</h2>
          <p style={{ color: C.muted, fontSize: 14 }}>Every agent runs in parallel. Zero waiting. Pure signal.</p>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: 16 }}>
          {FEATURES.map(({ icon, color, title, desc }) => (
            <article
              key={title} className="fc"
              style={{ borderTop: `2px solid ${color}` }}
              onMouseEnter={e => {
                e.currentTarget.style.boxShadow = `0 16px 50px ${color}22`;
                e.currentTarget.style.borderColor = color;
              }}
              onMouseLeave={e => {
                e.currentTarget.style.boxShadow = "none";
                e.currentTarget.style.borderColor = C.border;
                e.currentTarget.style.borderTopColor = color;
              }}
            >
              <div style={{ fontSize: 30, marginBottom: 12 }}>{icon}</div>
              <h3 style={{ fontSize: 16, fontWeight: 700, color, marginBottom: 7 }}>{title}</h3>
              <p style={{ fontSize: 14, color: C.muted, lineHeight: 1.65 }}>{desc}</p>
            </article>
          ))}
        </div>
      </section>

      {/* ══════ FOOTER CTA ══════ */}
      <section style={{ maxWidth: 1000, margin: "0 auto", padding: "0 32px 72px", zIndex: 2, position: "relative", textAlign: "center" }}>
        <div style={{
          background: `linear-gradient(135deg,rgba(167,239,158,0.06) 0%,rgba(94,248,208,0.05) 50%,rgba(167,239,158,0.04) 100%)`,
          border: `1px solid ${C.mint}33`,
          borderRadius: 16, padding: "60px 32px"
        }}>
          <div style={{
            fontFamily: "'JetBrains Mono',monospace", fontSize: 12,
            color: C.mintDim, letterSpacing: ".1em", marginBottom: 16
          }}>$ Cypher --run-review --pr latest</div>
          <h2 style={{
            fontSize: "clamp(1.8rem,3.5vw,2.8rem)", fontWeight: 800,
            background: `linear-gradient(90deg,${C.mint},${C.cyan})`,
            WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text",
            marginBottom: 14, letterSpacing: "-0.02em"
          }}>Ready to Ship Cleaner Code?</h2>
          <p style={{ color: C.muted, marginBottom: 36, fontSize: 15 }}>
            Six AI agents. Instant reviews. Zero setup required.
          </p>
          <Link href="/dashboard" className="mint-btn" id="lp-footer-cta">
            🚀 Launch Cypher AI
          </Link>
        </div>
        <p style={{ color: C.border, fontSize: 12, marginTop: 28, fontFamily: "'JetBrains Mono',monospace" }}>
          © 2025 Cypher AI · MIT Licence · Built for developers who ship
        </p>
      </section>
    </>
  );
}
