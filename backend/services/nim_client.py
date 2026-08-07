from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Any, Literal

import httpx

from backend.utils.settings import settings

logger = logging.getLogger(__name__)

_NIM_MAX_RETRIES = max(1, settings.nim_max_retries)

CallKind = Literal["agent", "summary", "docs", "structure"]


@dataclass(frozen=True)
class CallProfile:
    """Per-call-kind timeout and token budget."""

    timeout_seconds: float
    max_tokens: int


# Short structured JSON gets a tight budget; prose generation gets headroom.
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


class RatePacer:
    """
    Requests-per-minute pacer that does not serialize concurrent callers.

    The old implementation held an ``asyncio.Lock`` across its ``sleep``, which meant
    concurrent callers queued behind each other even when the API would happily accept
    parallel requests. Here the lock is held only long enough to *reserve* a send slot;
    each caller then waits for its own slot independently, so N callers overlap.
    """

    def __init__(self, rate_limit_rpm: int) -> None:
        self.rate_limit_rpm = max(1, rate_limit_rpm)
        self.min_interval = 60.0 / self.rate_limit_rpm
        self._next_slot = 0.0
        self._lock: asyncio.Lock | None = None

    def _get_lock(self) -> asyncio.Lock:
        # Created lazily so the client can be constructed before an event loop exists.
        if self._lock is None:
            self._lock = asyncio.Lock()
        return self._lock

    async def acquire(self) -> None:
        async with self._get_lock():
            now = time.perf_counter()
            slot = max(now, self._next_slot)
            self._next_slot = slot + self.min_interval
        wait_time = slot - time.perf_counter()
        if wait_time > 0:
            logger.debug("NIM rate pacing | waiting_ms=%.0f", wait_time * 1000)
            await asyncio.sleep(wait_time)


class NIMClient:
    """
    Async client for NVIDIA NIM chat completions.

    Holds one persistent ``httpx.AsyncClient`` (connection pool reuse across all calls)
    and bounds in-flight requests with a semaphore so LangGraph nodes can fan out safely.
    """

    def __init__(self, api_key: str | None = None) -> None:
        # Normalise: strip trailing slash, then strip accidental trailing /v1
        # so we can safely append /v1/chat/completions ourselves.
        base = settings.nim_base_url.rstrip("/")
        if base.endswith("/v1"):
            base = base[:-3]
        self.base_url = base
        # Use the role-specific key when given, otherwise the global NIM_API_KEY.
        self.api_key = api_key or settings.nim_api_key
        self._pacer = RatePacer(settings.nim_rate_limit_rpm)
        self._client: httpx.AsyncClient | None = None
        self._semaphore: asyncio.Semaphore | None = None
        self._client_lock: asyncio.Lock | None = None

    @property
    def enabled(self) -> bool:
        return bool(self.api_key)

    def _client_closed(self) -> bool:
        return self._client is None or self._client.is_closed

    # ── Resource management ───────────────────────────────────────────────────

    def _get_semaphore(self) -> asyncio.Semaphore:
        if self._semaphore is None:
            self._semaphore = asyncio.Semaphore(settings.nim_max_concurrency)
        return self._semaphore

    async def _get_client(self) -> httpx.AsyncClient:
        """Lazily build the shared client so it binds to the running event loop."""
        if self._client is not None and not self._client.is_closed:
            return self._client
        if self._client_lock is None:
            self._client_lock = asyncio.Lock()
        async with self._client_lock:
            if self._client is None or self._client.is_closed:
                limits = httpx.Limits(
                    max_connections=max(4, settings.nim_max_concurrency * 2),
                    max_keepalive_connections=max(2, settings.nim_max_concurrency),
                    keepalive_expiry=60.0,
                )
                # Per-request timeouts are passed at call time; this is the ceiling.
                self._client = httpx.AsyncClient(
                    limits=limits,
                    timeout=httpx.Timeout(float(settings.nim_docs_timeout_seconds)),
                    headers={"Content-Type": "application/json"},
                )
                logger.info(
                    "NIM client initialised | max_concurrency=%d rpm=%d",
                    settings.nim_max_concurrency,
                    settings.nim_rate_limit_rpm,
                )
        return self._client

    async def aclose(self) -> None:
        """Close the shared connection pool. Wired to FastAPI's shutdown event."""
        if self._client is not None and not self._client.is_closed:
            await self._client.aclose()
            logger.info("NIM client connection pool closed")
        self._client = None

    # ── Chat ──────────────────────────────────────────────────────────────────

    async def chat(
        self,
        model: str,
        system_prompt: str,
        user_prompt: str,
        temperature: float = 0.2,
        call_kind: CallKind | str = "agent",
        max_tokens: int | None = None,
        timeout_seconds: float | None = None,
    ) -> str | None:
        """
        Run one chat completion. Returns the assistant content, or ``None`` on failure.

        Never raises: every caller in this codebase has a deterministic fallback, so a
        failed LLM call must degrade the result rather than fail the job.
        """
        if not self.enabled:
            logger.info("NIM disabled (missing API key) | model=%s", model)
            return None

        profile = CALL_PROFILES.get(str(call_kind), _DEFAULT_PROFILE)
        effective_timeout = timeout_seconds or profile.timeout_seconds
        effective_max_tokens = max_tokens or profile.max_tokens

        url = f"{self.base_url}/v1/chat/completions"
        headers = {"Authorization": f"Bearer {self.api_key}"}
        payload: dict[str, Any] = {
            "model": model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "temperature": temperature,
            "max_tokens": effective_max_tokens,
        }

        client = await self._get_client()
        # A whole call (all attempts) may not exceed roughly 2x its single-attempt
        # timeout, so one slow agent cannot consume the entire job budget.
        deadline = time.perf_counter() + (effective_timeout * 2)

        async with self._get_semaphore():
            for attempt in range(1, _NIM_MAX_RETRIES + 1):
                if time.perf_counter() >= deadline:
                    logger.warning(
                        "NIM call budget exhausted | model=%s kind=%s attempt=%d",
                        model, call_kind, attempt,
                    )
                    return None

                await self._pacer.acquire()

                started = time.perf_counter()
                logger.info(
                    "NIM request started | model=%s kind=%s attempt=%d/%d",
                    model, call_kind, attempt, _NIM_MAX_RETRIES,
                )
                try:
                    response = await client.post(
                        url,
                        headers=headers,
                        json=payload,
                        timeout=effective_timeout,
                    )
                    response.raise_for_status()
                    data = response.json()
                    elapsed_ms = int((time.perf_counter() - started) * 1000)
                    logger.info(
                        "NIM request succeeded | model=%s kind=%s attempt=%d elapsed_ms=%d",
                        model, call_kind, attempt, elapsed_ms,
                    )
                    return data["choices"][0]["message"]["content"]
                except httpx.TimeoutException as exc:
                    elapsed_ms = int((time.perf_counter() - started) * 1000)
                    logger.warning(
                        "NIM timeout | model=%s kind=%s attempt=%d/%d elapsed_ms=%d: %s",
                        model, call_kind, attempt, _NIM_MAX_RETRIES, elapsed_ms, exc,
                    )
                except httpx.HTTPStatusError as exc:
                    elapsed_ms = int((time.perf_counter() - started) * 1000)
                    status = exc.response.status_code
                    body = exc.response.text[:300]
                    logger.warning(
                        "NIM HTTP error %s | model=%s kind=%s attempt=%d/%d elapsed_ms=%d: %s",
                        status, model, call_kind, attempt, _NIM_MAX_RETRIES, elapsed_ms, body,
                    )
                    # Retry rate-limited and transient upstream failures only.
                    if status not in {429, 500, 502, 503, 504}:
                        logger.warning(
                            "NIM request aborted (non-retriable status) | model=%s status=%s",
                            model, status,
                        )
                        return None
                except Exception as exc:
                    logger.warning("NIM call failed | model=%s kind=%s: %s", model, call_kind, exc)
                    return None

                if attempt < _NIM_MAX_RETRIES:
                    backoff_seconds = min((2 ** attempt) * 2, 8)
                    remaining = deadline - time.perf_counter()
                    if remaining <= backoff_seconds:
                        logger.warning(
                            "NIM retry skipped (insufficient budget) | model=%s kind=%s",
                            model, call_kind,
                        )
                        return None
                    logger.info(
                        "NIM retry scheduled | model=%s next_attempt=%d backoff_seconds=%d",
                        model, attempt + 1, backoff_seconds,
                    )
                    await asyncio.sleep(backoff_seconds)

        logger.warning("NIM request exhausted retries | model=%s kind=%s", model, call_kind)
        return None


class NIMClientPool:
    """
    Round-robin pool across up to 4 API keys.

    Every call to ``chat()`` is dispatched to the next client in rotation, so
    the effective quota across N active keys is N × per-key-limit.  Each client
    has its own ``RatePacer`` and concurrency ``Semaphore``, which means the keys
    are genuinely independent — they never block each other.

    Backward compatible: if none of NIM_API_KEY_1-4 are set the pool falls back
    to the single NIM_API_KEY, giving identical behaviour to the old single-client
    setup.
    """

    def __init__(self, api_keys: list[str]) -> None:
        active = [k.strip() for k in api_keys if k and k.strip()]
        if not active:
            # Fallback: single key, same as original behaviour.
            fallback = settings.nim_api_key.strip()
            active = [fallback] if fallback else []
        self._clients: list[NIMClient] = [NIMClient(api_key=k) for k in active]
        self._index = 0
        self._lock: asyncio.Lock | None = None
        logger.info(
            "NIM pool initialised | active_keys=%d",
            len(self._clients),
        )

    # ── Public interface (mirrors NIMClient) ──────────────────────────────────

    @property
    def enabled(self) -> bool:
        return any(c.enabled for c in self._clients)

    async def chat(
        self,
        model: str,
        system_prompt: str,
        user_prompt: str,
        temperature: float = 0.2,
        call_kind: str = "agent",
        max_tokens: int | None = None,
        timeout_seconds: float | None = None,
    ) -> str | None:
        if not self._clients:
            logger.info("NIM pool disabled (no API keys configured)")
            return None
        client = await self._next_client()
        return await client.chat(
            model=model,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            temperature=temperature,
            call_kind=call_kind,
            max_tokens=max_tokens,
            timeout_seconds=timeout_seconds,
        )

    async def aclose(self) -> None:
        """Close all connection pools in the pool."""
        for client in self._clients:
            if not client._client_closed():
                await client.aclose()
        logger.info("NIM pool closed | clients=%d", len(self._clients))

    # ── Internal ──────────────────────────────────────────────────────────────

    def _get_lock(self) -> asyncio.Lock:
        if self._lock is None:
            self._lock = asyncio.Lock()
        return self._lock

    async def _next_client(self) -> NIMClient:
        """Atomically advance the round-robin index and return the next client."""
        async with self._get_lock():
            client = self._clients[self._index % len(self._clients)]
            self._index += 1
            return client


# Process-wide pool — lazily created on first use.
_pool: NIMClientPool | None = None


def get_nim_pool() -> NIMClientPool:
    """Return the shared round-robin pool across all configured API keys."""
    global _pool
    if _pool is None:
        _pool = NIMClientPool([
            settings.nim_api_key_1,
            settings.nim_api_key_2,
            settings.nim_api_key_3,
            settings.nim_api_key_4,
        ])
    return _pool


def get_nim_client() -> NIMClientPool:
    """Backward-compatible alias → returns the shared pool."""
    return get_nim_pool()


async def aclose_all_nim_clients() -> None:
    """Close the pool. Wired to FastAPI shutdown."""
    global _pool
    if _pool is not None:
        await _pool.aclose()
        _pool = None

