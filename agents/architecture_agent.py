from __future__ import annotations

from typing import Any

from agents.base_agent import AgentFinding, BaseAgent


class ArchitectureAgent(BaseAgent):
    name = "Architecture"

    def analyze(self, parsed_files: list[dict[str, Any]], persona: str) -> list[AgentFinding]:
        findings: list[AgentFinding] = []

        for item in parsed_files:
            line_count = item.get("line_count", 0)
            fn_count = len(item.get("functions", []))

            if line_count > 650:
                finding = self._emit(
                    file=item["path"],
                    line=1,
                    issue_title="Oversized Module",
                    explanation="Large modules become difficult to reason about and test.",
                    severity="medium",
                    fix_suggestion="Split this module by domain responsibility and expose a slim interface layer.",
                    confidence=0.83,
                )
                if finding:
                    findings.append(finding)

            if fn_count > 35:
                finding = self._emit(
                    file=item["path"],
                    line=1,
                    issue_title="High Function Density",
                    explanation="Many functions in a single file suggests mixed responsibilities.",
                    severity="medium",
                    fix_suggestion="Group related functions into submodules by feature or abstraction layer.",
                    confidence=0.8,
                )
                if finding:
                    findings.append(finding)

        return findings[:6]
