from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class AgentPrompt:
    name: str
    focus: str
    instructions: str
    # Scope carved out explicitly so agents stop reporting each other's findings
    # under different titles (which defeats title-based deduplication).
    out_of_scope: str = ""
    # File extensions this agent can say anything useful about. Empty = any.
    extensions: tuple[str, ...] = ()
    # Content markers that make a file worth sending to this agent.
    content_markers: tuple[str, ...] = field(default_factory=tuple)


COMMON_CONSTRAINTS = """
Hard constraints:
- Report only issues with concrete evidence in the provided code.
- If evidence is insufficient, return an empty array.
- Do not speculate about unseen files or runtime behavior.
- Include exact file path and line number for every finding.
- Return STRICT JSON array only, no markdown fences, no prose, no preamble.

Output budget (strictly enforced):
- Keep each finding explanation to 2 sentences maximum.
- Return ONLY findings with confidence >= 0.80.
- Return at most 6 findings. Fewer, stronger findings are better than many weak ones.
- fix_suggestion must be one concrete, implementable sentence.
""".strip()


AGENT_PROMPTS: list[AgentPrompt] = [
    AgentPrompt(
        name="Bug & Safety",
        focus="Correctness defects, unsafe logic, silent failures.",
        instructions="""
Find concrete bug risks such as unsafe eval/exec, swallowed exceptions, wrong condition checks,
off-by-one errors, unhandled None/null, and operations that can fail without handling.
Prioritize issues that can break production behavior.
""".strip(),
        out_of_scope=(
            "Do NOT report: hardcoded secrets or injection (Security agent owns those), "
            "performance or complexity (Performance agent), missing docs (Readability agent), "
            "module layering (Architecture agent)."
        ),
        content_markers=("try", "except", "catch", "if ", "return", "None", "null", "eval", "exec"),
    ),
    AgentPrompt(
        name="Security",
        focus="Secrets exposure, injection vectors, insecure defaults.",
        instructions="""
Find hardcoded credentials, unsafe command execution, SQL/command/path injection, missing
validation on dangerous operations, and insecure crypto or auth handling.
Report only when the vulnerable pattern is explicit in the provided code.
""".strip(),
        out_of_scope=(
            "Do NOT report: generic error handling, performance, naming, or documentation. "
            "Only report issues with a concrete attacker-reachable path."
        ),
        content_markers=(
            "import", "require", "exec", "eval", "subprocess", "os.system", "request",
            "query", "sql", "select ", "insert ", "token", "secret", "password", "api_key",
            "apikey", "auth", "jwt", "hash", "crypt", "cipher", "session", "cookie",
        ),
    ),
    AgentPrompt(
        name="Performance",
        focus="Hot-path inefficiencies and scaling bottlenecks.",
        instructions="""
Find nested loops over large inputs, repeated I/O or network calls inside loops, unnecessary
full scans, redundant recomputation, and clearly avoidable CPU or memory hotspots.
Focus on patterns that materially impact scale.
""".strip(),
        out_of_scope=(
            "Do NOT report: correctness bugs, security issues, or style. "
            "Do NOT report micro-optimizations with no measurable impact."
        ),
        content_markers=(
            "for ", "while ", "map(", "filter(", ".map(", ".filter(", ".forEach(",
            "await", "fetch", "requests.", "query", "execute", "join", "sort", "range(",
        ),
    ),
    AgentPrompt(
        name="Readability & Docs",
        focus="Maintainability, clarity, and documentation quality.",
        instructions="""
Find non-trivial functions without docs, misleading names, deeply nested control flow, and
clarity issues that measurably increase review or onboarding risk.
""".strip(),
        out_of_scope=(
            "Do NOT report: cosmetic nits (spacing, quote style, line length), correctness bugs, "
            "security, performance, or module boundaries."
        ),
        content_markers=("def ", "function ", "class ", "const ", "async "),
    ),
    AgentPrompt(
        name="Architecture",
        focus="Module boundaries, layering, and responsibility separation.",
        instructions="""
Find concrete signs of poor module boundaries: god files mixing unrelated responsibilities,
tight coupling across layers, circular import risk, and business logic leaking into transport
or UI layers. Report only where the code evidence clearly indicates architectural debt.
""".strip(),
        out_of_scope=(
            "Do NOT report: single-function issues, missing docstrings, naming, or anything "
            "that does not concern the relationship BETWEEN modules."
        ),
        # Architecture only has signal on files that actually depend on other modules.
        content_markers=("import", "require", "from ", "export"),
    ),
    AgentPrompt(
        name="Accessibility",
        focus="Frontend accessibility violations with concrete markup evidence.",
        instructions="""
Find missing alt text, non-semantic interactive elements (clickable div/span), keyboard
inaccessibility, missing form labels, and obvious ARIA/semantic issues visible directly in
the provided UI code.
""".strip(),
        out_of_scope=(
            "Do NOT report: anything outside rendered markup and its handlers. "
            "Do NOT report backend, build, or configuration issues."
        ),
        extensions=("tsx", "jsx", "html", "vue", "svelte"),
        content_markers=("<", "onClick", "onclick", "aria", "role=", "alt=", "<img", "<button"),
    ),
]


AGENT_PROMPTS_BY_NAME: dict[str, AgentPrompt] = {p.name: p for p in AGENT_PROMPTS}


JSON_SCHEMA_GUIDE = """
Output schema:
[
  {
    "file": "path/to/file",
    "line": 123,
    "issue_title": "Short precise title",
    "explanation": "What is wrong and why it matters. Two sentences maximum.",
    "severity": "low|medium|high|critical",
    "fix_suggestion": "One specific actionable fix.",
    "confidence": 0.0,
    "agent": "Exact agent name"
  }
]
""".strip()


# Single-call prompt used by the fast path (small diffs) and by the PR webhook path.
FAST_REVIEW_SCHEMA_GUIDE = """
Return STRICT JSON object only with this exact shape:
{
  "summary": "short actionable review summary, 3 sentences maximum",
  "findings": [
    {
      "file": "path/to/file",
      "line": 1,
      "issue_title": "title",
      "explanation": "two sentences maximum",
      "severity": "low|medium|high|critical",
      "fix_suggestion": "one concrete fix",
      "confidence": 0.0,
      "agent": "Quick Review"
    }
  ]
}

Rules:
- Report only concrete issues visible in the provided code.
- confidence must be >= 0.80.
- Keep findings high signal; at most 8 findings.
- If no clear issues exist, return empty findings and a brief summary saying so.
""".strip()


FILE_SUMMARY_GUIDE = """
Return STRICT JSON object only, mapping each file path to a plain-English summary:
{
  "path/to/file.py": "What this file does, in 1-2 sentences. Plain English, no jargon."
}

Rules:
- Describe purpose and responsibility, not line-by-line behavior.
- Write for a junior developer who has never seen this codebase.
- Use the exact file paths given to you as keys. Do not invent paths.
- 2 sentences maximum per file.
""".strip()
