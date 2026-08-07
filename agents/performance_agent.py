from __future__ import annotations

import re
from typing import Any

from agents.base_agent import AgentFinding, BaseAgent


class PerformanceAgent(BaseAgent):
    name = "Performance"

    def analyze(self, parsed_files: list[dict[str, Any]], persona: str) -> list[AgentFinding]:
        findings: list[AgentFinding] = []

        for item in parsed_files:
            lines = item["content"].splitlines()
            joined = "\n".join(lines)

            nested_loop = re.search(r"for\s+.+:\n(?:\s{2,}|\t)+for\s+.+:", joined)
            if nested_loop:
                line = joined[: nested_loop.start()].count("\n") + 1
                finding = self._emit(
                    file=item["path"],
                    line=line,
                    issue_title="Nested Loop Hot Path",
                    explanation="Nested loops can lead to quadratic behavior on large input sets.",
                    severity="medium",
                    fix_suggestion="Consider indexing data structures (dict/set) or precomputing lookups.",
                    confidence=0.79,
                )
                if finding:
                    findings.append(finding)

            for i, line in enumerate(lines, start=1):
                if "for " in line and i < len(lines) and "open(" in lines[i]:
                    finding = self._emit(
                        file=item["path"],
                        line=i,
                        issue_title="I/O Per Iteration",
                        explanation="Opening files inside loops increases I/O overhead significantly.",
                        severity="medium",
                        fix_suggestion="Open file handles outside the loop or batch I/O operations.",
                        confidence=0.81,
                    )
                    if finding:
                        findings.append(finding)

        return findings[:8]
