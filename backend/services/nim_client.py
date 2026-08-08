"""
NIM client — three dedicated key-pools, one per function.

Architecture:
    ReviewPool   → meta/llama-3.1-8b-instruct  (6 review agents)
    DocsPool     → google/gemma-4-31b-it        (README + file summaries)
    StructurePool→ mistralai/mistral-nemotron   (codebase structure + escalation summary)

Each pool holds all 4 API keys in a round-robin, with instant failover
to the next key on any 503/429 capacity error.  Because the three pools
use three completely different NVIDIA model endpoints (three different GPU
clusters), they never compete for the same 16 NVIDIA worker slots.
"""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Any, Literal

import httpx

from backend.utils.settings import settings

logger = logging.getLogger(__name__)

CallKind = Literal["agent", "summary", "docs", "structure"]

# ── Timeout budgets per call kind ─────────────────────────────────────────────

@dataclass(frozen=True)
class CallProfile:
    timeout_seconds: float
    max_tokens: int


CALL_PROFILES: dict[str, CallProfile] = {
    "agent": CallProfile(
        timeout_seconds=float(settings.nim_agent_timeout_seconds),
        max_tokens=settings.nim_max_tokens_agent,
    ),
    "structure": CallProfile(
        timeout_seconds=float(settings.nim_docs_timeout_seconds),
        max_tokens=settings.nim_max_tokens_summary,
    ),
    "summary": CallProfile(
        timeout_seconds=float(settings.nim_docs_timeout_seconds),
        max_tokens=settings.nim_max_tokens_summary,
    ),
    "docs": CallProfile(
        timeout_seconds=float(settings.nim_docs_timeout_seconds),
        max_tokens=settings.nim_max_tokens_summary,
    ),
}

_DEFAULT_PROFILE = CallProfile(
    timeout_seconds=float(settings.nim_request_timeout_seconds),
    max_tokens=settings.nim_max_tokens,
)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _mask_key(key: str) -> str:
    if not key or not key.strip():
        return "<not_set>"
    k = key.strip()
    if len(k) <= 8:
        return f"{k[:2]}***"
    return f"{k[:6]}...{k[-4:]}"


# ── Single-key NIM client ─────────────────────────────────────────────────────

class NIMClient:
    """
    Thin async httpx wrapper around a single NVIDIA NIM API key.

    No rate pacer — requests are fired immediately. Concurrency is managed
    at the pool level.  On 503/429 capacity errors the pool rotates to the
    next key instantly (0 ms delay).
    """

    def __init__(self, api_key: str, key_slot: int = 1, timeout_ceiling: float = 90.0) -> None:
        base = settings.nim_base_url.rstrip("/")
        if base.endswith("/v1"):
            base = base[:-3]
        self.base_url = base
        self.api_key = api_key
        self.key_slot = key_slot
        self.masked_key = _mask_key(api_key)
        self._timeout_ceiling = timeout_ceiling
        self._client: httpx.AsyncClient | None = None
        self._client_lock: asyncio.Lock | None = None

    @property
    def enabled(self) -> bool:
        return bool(self.api_key)

    def _client_closed(self) -> bool:
        return self._client is None or self._client.is_closed

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is not None and not self._client.is_closed:
            return self._client
        if self._client_lock is None:
            self._client_lock = asyncio.Lock()
        async with self._client_lock:
            if self._client is None or self._client.is_closed:
                limits = httpx.Limits(
                    max_connections=20,
                    max_keepalive_connections=10,
                    keepalive_expiry=60.0,
                )
                self._client = httpx.AsyncClient(
                    limits=limits,
                    timeout=httpx.Timeout(self._timeout_ceiling, connect=10.0),
                    headers={"Content-Type": "application/json"},
                )
        return self._client

    async def aclose(self) -> None:
        if self._client is not None and not self._client.is_closed:
            await self._client.aclose()
        self._client = None

    async def call(
        self,
        model: str,
        system_prompt: str,
        user_prompt: str,
        temperature: float,
        max_tokens: int,
        timeout: float,
        call_kind: str,
    ) -> tuple[str | None, bool]:
        """
        Fire one request.  Returns (content, is_capacity_error).
        is_capacity_error=True means the caller should retry on another key.
        """
        if not self.enabled:
            return None, False

        url = f"{self.base_url}/v1/chat/completions"
        payload: dict[str, Any] = {
            "model": model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        headers = {"Authorization": f"Bearer {self.api_key}"}

        client = await self._get_client()
        started = time.perf_counter()
        logger.info(
            "NIM request started | model=%s kind=%s key_slot=%d (%s) timeout=%ds",
            model, call_kind, self.key_slot, self.masked_key, int(timeout),
        )
        try:
            response = await client.post(url, headers=headers, json=payload, timeout=timeout)
            response.raise_for_status()
            data = response.json()
            elapsed_ms = int((time.perf_counter() - started) * 1000)
            logger.info(
                "NIM request succeeded | model=%s kind=%s elapsed_ms=%d key_slot=%d (%s)",
                model, call_kind, elapsed_ms, self.key_slot, self.masked_key,
            )
            return data["choices"][0]["message"]["content"], False

        except httpx.TimeoutException as exc:
            elapsed_ms = int((time.perf_counter() - started) * 1000)
            logger.warning(
                "NIM timeout (>%ds) | model=%s kind=%s elapsed_ms=%d key_slot=%d (%s): %s",
                int(timeout), model, call_kind, elapsed_ms, self.key_slot, self.masked_key, exc,
            )
            return None, False

        except httpx.HTTPStatusError as exc:
            elapsed_ms = int((time.perf_counter() - started) * 1000)
            status = exc.response.status_code
            body = exc.response.text[:300]
            logger.warning(
                "NIM HTTP %s | model=%s kind=%s elapsed_ms=%d key_slot=%d (%s): %s",
                status, model, call_kind, elapsed_ms, self.key_slot, self.masked_key, body,
            )
            return None, status in {429, 503}

        except Exception as exc:
            elapsed_ms = int((time.perf_counter() - started) * 1000)
            logger.warning(
                "NIM call failed | model=%s kind=%s elapsed_ms=%d key_slot=%d (%s): %s",
                model, call_kind, elapsed_ms, self.key_slot, self.masked_key, exc,
            )
            return None, False


# ── Role-based pool: holds all 4 keys, dedicated to one model + function ──────

class RolePool:
    """
    A pool of NIMClient instances (one per API key) dedicated to a single
    model and function role (review / docs / structure).

    Requests are dispatched round-robin across keys.  On a 503/429 capacity
    error the pool immediately rotates to the next key (0 ms delay), cycling
    through all keys before giving up.
    """

    def __init__(self, role: str, model: str, api_keys: list[str], timeout_ceiling: float = 90.0) -> None:
        self.role = role
        self.model = model
        clients: list[NIMClient] = []
        for idx, k in enumerate(api_keys, 1):
            if k and k.strip():
                clients.append(NIMClient(api_key=k.strip(), key_slot=idx, timeout_ceiling=timeout_ceiling))
        # Fallback to legacy single key if pool keys are unset
        if not clients:
            fallback = settings.nim_api_key.strip()
            if fallback:
                clients.append(NIMClient(api_key=fallback, key_slot=1, timeout_ceiling=timeout_ceiling))
        self._clients = clients
        self._index = 0
        self._lock: asyncio.Lock | None = None

        slots_info = ", ".join(f"slot_{c.key_slot}={c.masked_key}" for c in clients) or "none"
        logger.info(
            "NIM %s pool ready | model=%s keys=%d/%d | %s",
            role, model, len(clients), len(api_keys), slots_info,
        )

    @property
    def enabled(self) -> bool:
        return bool(self._clients)

    def _get_lock(self) -> asyncio.Lock:
        if self._lock is None:
            self._lock = asyncio.Lock()
        return self._lock

    async def _next_client(self) -> NIMClient:
        async with self._get_lock():
            client = self._clients[self._index % len(self._clients)]
            self._index += 1
            return client

    async def chat(
        self,
        model: str,
        system_prompt: str,
        user_prompt: str,
        temperature: float = 0.1,
        call_kind: str = "agent",
        max_tokens: int | None = None,
        timeout_seconds: float | None = None,
    ) -> str | None:
        if not self._clients:
            logger.warning("NIM %s pool: no API keys configured", self.role)
            return None

        profile = CALL_PROFILES.get(call_kind, _DEFAULT_PROFILE)
        effective_timeout = timeout_seconds or profile.timeout_seconds
        effective_max_tokens = max_tokens or profile.max_tokens

        # Cycle through ALL keys on capacity errors, then give up.
        n = len(self._clients)
        for attempt in range(1, n + 1):
            client = await self._next_client()
            content, is_capacity = await client.call(
                model=model,
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                temperature=temperature,
                max_tokens=effective_max_tokens,
                timeout=effective_timeout,
                call_kind=call_kind,
            )
            if content is not None:
                return content
            if is_capacity and attempt < n:
                logger.info(
                    "NIM %s pool: 503 capacity on slot_%d — rotating to next key (attempt %d/%d)",
                    self.role, client.key_slot, attempt + 1, n,
                )
                continue
            break

        logger.warning(
            "NIM %s pool: all %d key(s) failed for model=%s kind=%s",
            self.role, n, model, call_kind,
        )
        return None

    async def aclose(self) -> None:
        for client in self._clients:
            if not client._client_closed():
                await client.aclose()


# ── Process-wide role pools ────────────────────────────────────────────────────

_ALL_KEYS = [
    settings.nim_api_key_1,
    settings.nim_api_key_2,
    settings.nim_api_key_3,
    settings.nim_api_key_4,
]

_review_pool: RolePool | None = None
_docs_pool: RolePool | None = None
_structure_pool: RolePool | None = None


def get_review_pool() -> RolePool:
    """Review agents pool — meta/llama-3.1-8b-instruct, all 4 keys."""
    global _review_pool
    if _review_pool is None:
        _review_pool = RolePool(
            role="review",
            model=settings.nim_model_qwen_review,
            api_keys=_ALL_KEYS,
            timeout_ceiling=float(settings.nim_agent_timeout_seconds) + 10,
        )
    return _review_pool


def get_docs_pool() -> RolePool:
    """Docs/README pool — google/gemma-4-31b-it, all 4 keys."""
    global _docs_pool
    if _docs_pool is None:
        _docs_pool = RolePool(
            role="docs",
            model=settings.nim_model_qwen_docs,
            api_keys=_ALL_KEYS,
            timeout_ceiling=float(settings.nim_docs_timeout_seconds) + 10,
        )
    return _docs_pool


def get_structure_pool() -> RolePool:
    """Structure analysis pool — mistralai/mistral-nemotron, all 4 keys."""
    global _structure_pool
    if _structure_pool is None:
        _structure_pool = RolePool(
            role="structure",
            model=settings.nim_model_neotron,
            api_keys=_ALL_KEYS,
            timeout_ceiling=float(settings.nim_docs_timeout_seconds) + 10,
        )
    return _structure_pool


# ── Backward compatibility shims ───────────────────────────────────────────────

def get_nim_pool() -> RolePool:
    """Backward-compatible alias — returns the review pool."""
    return get_review_pool()


def get_nim_client() -> RolePool:
    """Backward-compatible alias — returns the review pool."""
    return get_review_pool()


async def aclose_all_nim_clients() -> None:
    """Close all three role pools. Wired to FastAPI shutdown."""
    global _review_pool, _docs_pool, _structure_pool
    for pool, name in [(_review_pool, "review"), (_docs_pool, "docs"), (_structure_pool, "structure")]:
        if pool is not None:
            await pool.aclose()
            logger.info("NIM %s pool closed", name)
    _review_pool = None
    _docs_pool = None
    _structure_pool = None
