from __future__ import annotations

import re
from typing import Any

from agents.base_agent import AgentFinding, BaseAgent


class AccessibilityAgent(BaseAgent):
    name = "Accessibility"

    def analyze(self, parsed_files: list[dict[str, Any]], persona: str) -> list[AgentFinding]:
        findings: list[AgentFinding] = []

        for item in parsed_files:
            if not item["path"].endswith((".tsx", ".jsx", ".html")):
                continue

            lines = item["content"].splitlines()
            for i, line in enumerate(lines, start=1):
                if "<img" in line and "alt=" not in line:
                    finding = self._emit(
                        file=item["path"],
                        line=i,
                        issue_title="Image Missing Alt Text",
                        explanation="Images without alt text reduce accessibility for screen reader users.",
                        severity="high",
                        fix_suggestion="Add a meaningful alt attribute describing content or use alt=\"\" for decorative images.",
                        confidence=0.93,
                    )
                    if finding:
                        findings.append(finding)

                if re.search(r"<div[^>]*onClick=", line) and "role=" not in line:
                    finding = self._emit(
                        file=item["path"],
                        line=i,
                        issue_title="Clickable Div Without Role",
                        explanation="Interactive div elements should include semantic role and keyboard support.",
                        severity="medium",
                        fix_suggestion="Use a button element or add role, tabIndex, and keyboard handlers.",
                        confidence=0.88,
                    )
                    if finding:
                        findings.append(finding)

        return findings[:8]
