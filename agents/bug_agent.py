from __future__ import annotations

import re
from typing import Any

from agents.base_agent import AgentFinding, BaseAgent


class BugSafetyAgent(BaseAgent):
    name = "Bug & Safety"

    def analyze(self, parsed_files: list[dict[str, Any]], persona: str) -> list[AgentFinding]:
        findings: list[AgentFinding] = []

        for item in parsed_files:
            lines = item["content"].splitlines()
            for i, line in enumerate(lines, start=1):
                if re.search(r"\beval\s*\(", line) or re.search(r"\bexec\s*\(", line):
                    finding = self._emit(
                        file=item["path"],
                        line=i,
                        issue_title="Unsafe Dynamic Code Execution",
                        explanation="Dynamic evaluation can execute untrusted input and cause runtime safety issues.",
                        severity="high",
                        fix_suggestion="Replace eval/exec with explicit parsing or a strict allow-list of supported operations.",
                        confidence=0.94,
                    )
                    if finding:
                        findings.append(finding)

                if "except Exception:" in line:
                    lookahead = "\n".join(lines[i : i + 2])
                    if "pass" in lookahead:
                        finding = self._emit(
                            file=item["path"],
                            line=i,
                            issue_title="Broad Exception Suppressed",
                            explanation="Catching Exception and silently passing can hide production failures.",
                            severity="medium",
                            fix_suggestion="Catch specific exception types and log context before handling.",
                            confidence=0.89,
                        )
                        if finding:
                            findings.append(finding)

        return findings[:8]
