from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class PersonaProfile:
    prompt_guidance: str
    explanation_suffix: str
    fix_suffix: str


PERSONA_GUIDANCE: dict[str, PersonaProfile] = {
    "Intern": PersonaProfile(
        prompt_guidance=(
            "Audience profile: early-career intern.\n"
            "- Use plain language and define technical terms the first time they appear.\n"
            "- Explain impact concretely: what could break, who notices it, and when.\n"
            "- Keep reasoning step-by-step and avoid unexplained jumps.\n"
            "- Prefer one safe, minimal fix first; include exactly one follow-up verification step.\n"
            "- Keep tone encouraging and actionable."
        ),
        explanation_suffix=(
            "Why this matters: this can cause bugs that are hard to trace later and reduce confidence during handoff."
        ),
        fix_suffix=(
            "Start with the smallest safe fix, then validate with one focused test covering the affected path."
        ),
    ),
    "Student": PersonaProfile(
        prompt_guidance=(
            "Audience profile: student building software engineering fundamentals.\n"
            "- Connect each issue to core principles (correctness, maintainability, readability, testing).\n"
            "- Explain trade-offs briefly so the reader learns why one approach is preferred.\n"
            "- Highlight the failure mode and the invariant the fix restores.\n"
            "- Suggest practical fixes that reinforce good engineering habits.\n"
            "- Keep the explanation concise but concept-rich."
        ),
        explanation_suffix=(
            "Concept: this ties to maintainability and correctness under change, where clear invariants reduce regression risk."
        ),
        fix_suffix=(
            "Apply a principle-driven fix and add or update a test that proves the expected behavior boundary."
        ),
    ),
    "Frontend Developer": PersonaProfile(
        prompt_guidance=(
            "Audience profile: frontend engineer focused on user-facing quality.\n"
            "- Prioritize user impact, accessibility, state consistency, and component boundaries.\n"
            "- Call out contract mismatches between UI and API surfaces.\n"
            "- Include implications for rendering behavior, perceived performance, and edge interactions.\n"
            "- Favor fixes that keep components predictable and reduce UI regressions.\n"
            "- Keep recommendations concrete and implementation-ready."
        ),
        explanation_suffix=(
            "User impact: this can degrade interaction clarity, accessibility expectations, or consistency across component states."
        ),
        fix_suffix=(
            "Prioritize user-facing correctness, semantic accessibility behavior, and clear component/API contracts."
        ),
    ),
    "Backend Developer": PersonaProfile(
        prompt_guidance=(
            "Audience profile: backend engineer focused on reliability and scale.\n"
            "- Prioritize correctness, fault tolerance, data integrity, and service boundaries.\n"
            "- Identify operational impact (latency, throughput, retries, failure isolation).\n"
            "- Highlight assumptions around concurrency, idempotency, and observability.\n"
            "- Recommend fixes that improve resilience and keep behavior explicit.\n"
            "- Keep guidance practical for production systems."
        ),
        explanation_suffix=(
            "Operational impact: this can weaken reliability under load, increase failure blast radius, or hide production faults."
        ),
        fix_suffix=(
            "Prioritize reliability, performance characteristics, and explicit service boundary behavior with observable failure handling."
        ),
    ),
}


def persona_style(persona: str) -> str:
    return PERSONA_GUIDANCE.get(persona, PERSONA_GUIDANCE["Student"]).prompt_guidance


def persona_explanation_suffix(persona: str) -> str:
    return PERSONA_GUIDANCE.get(persona, PERSONA_GUIDANCE["Student"]).explanation_suffix


def persona_fix_suffix(persona: str) -> str:
    return PERSONA_GUIDANCE.get(persona, PERSONA_GUIDANCE["Student"]).fix_suffix
