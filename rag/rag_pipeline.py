from __future__ import annotations

from typing import Any

from rag.chunker import chunk_parsed_files
from rag.vector_store import InMemoryVectorStore


class RAGPipeline:
    def __init__(self) -> None:
        self.store = InMemoryVectorStore()

    def index_repository(self, parsed_files: list[dict[str, Any]]) -> dict[str, int]:
        chunks = chunk_parsed_files(parsed_files)
        self.store.clear()
        self.store.upsert_chunks(chunks)
        return {"chunks": len(chunks), "files": len(parsed_files)}

    def retrieve(self, query: str, k: int = 8) -> list[dict[str, Any]]:
        return self.store.query(query, k=k)
