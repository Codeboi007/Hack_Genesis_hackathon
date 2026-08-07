from __future__ import annotations

import math
import re


class SimpleEmbedder:
    """Deterministic hashed bag-of-words embedding for in-memory retrieval."""

    def __init__(self, dim: int = 256) -> None:
        self.dim = dim

    def embed(self, text: str) -> list[float]:
        tokens = re.findall(r"[a-zA-Z_][a-zA-Z0-9_]{1,30}", text.lower())
        vec = [0.0] * self.dim
        if not tokens:
            return vec

        for tok in tokens:
            vec[hash(tok) % self.dim] += 1.0

        norm = math.sqrt(sum(v * v for v in vec)) or 1.0
        return [v / norm for v in vec]


def cosine_similarity(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b))
