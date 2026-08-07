from __future__ import annotations

from typing import Any

from agents.accessibility_agent import AccessibilityAgent
from agents.architecture_agent import ArchitectureAgent
from agents.base_agent import AgentFinding, SEVERITY_ORDER
from agents.bug_agent import BugSafetyAgent
from agents.performance_agent import PerformanceAgent
from agents.readability_agent import ReadabilityDocsAgent
from agents.security_agent import SecurityAgent


class ReviewOrchestrator:
    def __init__(self) -> None:
        self.agents = [
            BugSafetyAgent(),
            SecurityAgent(),
            PerformanceAgent(),
            ReadabilityDocsAgent(),
            ArchitectureAgent(),
            AccessibilityAgent(),
        ]

    def run(self, parsed_files: list[dict[str, Any]], persona: str) -> list[AgentFinding]:
        findings: list[AgentFinding] = []
        for agent in self.agents:
            findings.extend(agent.analyze(parsed_files, persona))

        findings.sort(
            key=lambda f: (SEVERITY_ORDER.get(f.severity, 0), f.confidence, -f.line),
            reverse=True,
        )

        seen = set()
        unique: list[AgentFinding] = []
        for finding in findings:
            key = (finding.file, finding.line, finding.issue_title)
            if key in seen:
                continue
            seen.add(key)
            unique.append(finding)

        return unique[:40]
