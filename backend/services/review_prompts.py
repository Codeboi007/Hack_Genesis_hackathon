from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class AgentPrompt:
    name: str
    focus: str
    instructions: str


COMMON_CONSTRAINTS = """
Hard constraints:
- Report only issues with concrete evidence in the provided code.
- If evidence is insufficient, return an empty array.
- Do not speculate about unseen files or runtime behavior.
- Include exact file path and line number for every finding.
- Return STRICT JSON array only, no markdown, no prose.
- Keep findings high signal; prefer fewer, stronger findings.
""".strip()


AGENT_PROMPTS: list[AgentPrompt] = [
    AgentPrompt(
        name="Bug & Safety",
        focus="Correctness defects, unsafe logic, silent failures.",
        instructions="""
Find concrete bug risks such as unsafe eval/exec, swallowed exceptions, wrong condition checks,
and operations that can fail without handling. Prioritize issues that can break production behavior.
""".strip(),
    ),
    AgentPrompt(
        name="Security",
        focus="Secrets exposure, injection vectors, insecure defaults.",
        instructions="""
Find hardcoded credentials, unsafe command execution, missing validation on dangerous operations,
and code paths with obvious injection risk. Report only when the vulnerable pattern is explicit.
""".strip(),
    ),
    AgentPrompt(
        name="Performance",
        focus="Hot-path inefficiencies and scaling bottlenecks.",
        instructions="""
Find expensive nested loops, repeated I/O in loops, unnecessary full scans, and clearly avoidable
CPU or memory hotspots. Focus on patterns that materially impact scale.
""".strip(),
    ),
    AgentPrompt(
        name="Readability & Docs",
        focus="Maintainability, clarity, and documentation quality.",
        instructions="""
Find non-trivial functions without docs, confusing constructs that block maintenance,
and clarity issues that increase review risk. Avoid cosmetic-only nits.
""".strip(),
    ),
    AgentPrompt(
        name="Architecture",
        focus="Module boundaries, layering, and responsibility separation.",
        instructions="""
Find concrete signs of poor module boundaries (god files, mixed responsibilities,
tight coupling) where the code evidence clearly indicates architectural debt.
""".strip(),
    ),
    AgentPrompt(
        name="Accessibility",
        focus="Frontend accessibility violations with concrete markup evidence.",
        instructions="""
Find missing alt text, non-semantic interactive elements, keyboard inaccessibility,
and obvious ARIA/semantic issues visible directly in UI code.
""".strip(),
    ),
]


JSON_SCHEMA_GUIDE = """
Output schema:
[
  {
    "file": "path/to/file",
    "line": 123,
    "issue_title": "Short precise title",
    "explanation": "What is wrong and why it matters.",
    "severity": "low|medium|high|critical",
    "fix_suggestion": "Specific actionable fix.",
    "confidence": 0.0,
    "agent": "Exact agent name"
  }
]
""".strip()
