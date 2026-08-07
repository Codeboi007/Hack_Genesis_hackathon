from __future__ import annotations

import re
from typing import Any

from agents.base_agent import AgentFinding, BaseAgent


class SecurityAgent(BaseAgent):
    name = "Security"

    def analyze(self, parsed_files: list[dict[str, Any]], persona: str) -> list[AgentFinding]:
        findings: list[AgentFinding] = []
        secret_pattern = re.compile(r"(?i)(api[_-]?key|secret|password|token)\s*[:=]\s*['\"][^'\"]{6,}['\"]")

        for item in parsed_files:
            lines = item["content"].splitlines()
            for i, line in enumerate(lines, start=1):
                if secret_pattern.search(line):
                    finding = self._emit(
                        file=item["path"],
                        line=i,
                        issue_title="Potential Hardcoded Secret",
                        explanation="Credential-like values appear directly in source code.",
                        severity="critical",
                        fix_suggestion="Move secrets to environment variables or a secure secret manager.",
                        confidence=0.9,
                    )
                    if finding:
                        findings.append(finding)

                if "subprocess" in line and "shell=True" in line:
                    finding = self._emit(
                        file=item["path"],
                        line=i,
                        issue_title="Command Execution With shell=True",
                        explanation="Using shell=True can enable command injection if arguments are user-influenced.",
                        severity="high",
                        fix_suggestion="Pass command arguments as a list and avoid shell=True.",
                        confidence=0.92,
                    )
                    if finding:
                        findings.append(finding)

        return findings[:8]
