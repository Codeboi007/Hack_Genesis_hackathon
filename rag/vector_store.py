from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from rag.embedder import SimpleEmbedder, cosine_similarity


@dataclass
class InMemoryVectorStore:
    embedder: SimpleEmbedder = field(default_factory=SimpleEmbedder)
    items: list[dict[str, Any]] = field(default_factory=list)

    def clear(self) -> None:
        self.items.clear()

    def upsert_chunks(self, chunks: list[dict[str, Any]]) -> None:
        for chunk in chunks:
            self.items.append({**chunk, "embedding": self.embedder.embed(chunk["text"])})

    def query(self, text: str, k: int = 8) -> list[dict[str, Any]]:
        query_vec = self.embedder.embed(text)
        scored = [
            {**item, "score": cosine_similarity(query_vec, item["embedding"])}
            for item in self.items
        ]
        scored.sort(key=lambda x: x["score"], reverse=True)
        return scored[:k]
