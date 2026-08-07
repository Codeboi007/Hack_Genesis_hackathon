from __future__ import annotations

from dataclasses import dataclass
from typing import Any

SEVERITY_ORDER = {"critical": 4, "high": 3, "medium": 2, "low": 1}


@dataclass
class AgentFinding:
    file: str
    line: int
    issue_title: str
    explanation: str
    severity: str
    fix_suggestion: str
    confidence: float
    agent: str


class BaseAgent:
    name = "base"
    min_confidence = 0.7

    def analyze(self, parsed_files: list[dict[str, Any]], persona: str) -> list[AgentFinding]:
        raise NotImplementedError

    def _emit(
        self,
        *,
        file: str,
        line: int,
        issue_title: str,
        explanation: str,
        severity: str,
        fix_suggestion: str,
        confidence: float,
    ) -> AgentFinding | None:
        if confidence < self.min_confidence:
            return None
        return AgentFinding(
            file=file,
            line=line,
            issue_title=issue_title,
            explanation=explanation,
            severity=severity,
            fix_suggestion=fix_suggestion,
            confidence=confidence,
            agent=self.name,
        )
