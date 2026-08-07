from __future__ import annotations

import ast
from typing import Any

from agents.base_agent import AgentFinding, BaseAgent


class ReadabilityDocsAgent(BaseAgent):
    name = "Readability & Docs"

    def analyze(self, parsed_files: list[dict[str, Any]], persona: str) -> list[AgentFinding]:
        findings: list[AgentFinding] = []

        for item in parsed_files:
            if not item["path"].endswith(".py"):
                continue

            code = item["content"]
            lines = code.splitlines()
            try:
                tree = ast.parse(code)
            except SyntaxError:
                continue

            for node in ast.walk(tree):
                if isinstance(node, ast.FunctionDef):
                    if len(node.body) > 3 and ast.get_docstring(node) is None:
                        finding = self._emit(
                            file=item["path"],
                            line=node.lineno,
                            issue_title="Missing Function Docstring",
                            explanation="Non-trivial function lacks a docstring, which reduces maintainability.",
                            severity="low",
                            fix_suggestion="Add a short docstring describing inputs, outputs, and side effects.",
                            confidence=0.76,
                        )
                        if finding:
                            findings.append(finding)

            for i, line in enumerate(lines, start=1):
                if len(line) > 140:
                    finding = self._emit(
                        file=item["path"],
                        line=i,
                        issue_title="Very Long Line",
                        explanation="Long lines are harder to read and review in pull requests.",
                        severity="low",
                        fix_suggestion="Break expressions across multiple lines with clear variable naming.",
                        confidence=0.78,
                    )
                    if finding:
                        findings.append(finding)

        return findings[:8]
