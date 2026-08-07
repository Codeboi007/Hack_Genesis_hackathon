from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

import httpx

from backend.utils.settings import settings

logger = logging.getLogger(__name__)

# Keep NIM calls bounded so background jobs do not stall indefinitely.
_NIM_TIMEOUT = float(settings.nim_request_timeout_seconds)
_NIM_MAX_RETRIES = max(1, settings.nim_max_retries)
_NIM_MAX_TOKENS = max(128, settings.nim_max_tokens)

# Rate limiter: 40 rpm = 0.67 req/sec = 1.5 sec between requests
_NIM_RATE_LIMIT_RPM = max(1, settings.nim_rate_limit_rpm)
_MIN_REQUEST_INTERVAL = 60.0 / _NIM_RATE_LIMIT_RPM


class RateLimiter:
    """Token bucket rate limiter for API requests."""
    
    def __init__(self, rate_limit_rpm: int) -> None:
        self.rate_limit_rpm = max(1, rate_limit_rpm)
        self.min_interval = 60.0 / self.rate_limit_rpm
        self.last_request_time = 0.0
        self._lock = asyncio.Lock()
    
    async def acquire(self) -> None:
        """Wait until it's safe to make the next request."""
        async with self._lock:
            elapsed = time.perf_counter() - self.last_request_time
            if elapsed < self.min_interval:
                wait_time = self.min_interval - elapsed
                logger.debug("NIM rate limit | waiting_ms=%.0f", wait_time * 1000)
                await asyncio.sleep(wait_time)
            self.last_request_time = time.perf_counter()


class NIMClient:
    def __init__(self) -> None:
        # Normalise: strip trailing slash, then strip accidental trailing /v1
        # so we can safely append /v1/chat/completions ourselves.
        base = settings.nim_base_url.rstrip("/")
        if base.endswith("/v1"):
            base = base[:-3]
        self.base_url = base
        self.api_key = settings.nim_api_key
        self._rate_limiter = RateLimiter(_NIM_RATE_LIMIT_RPM)

    @property
    def enabled(self) -> bool:
        return bool(self.api_key)

    async def chat(
        self,
        model: str,
        system_prompt: str,
        user_prompt: str,
        temperature: float = 0.2,
    ) -> str | None:
        if not self.enabled:
            logger.info("NIM disabled (missing API key) | model=%s", model)
            return None

        url = f"{self.base_url}/v1/chat/completions"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        payload: dict[str, Any] = {
            "model": model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "temperature": temperature,
            # Keep bounded to reduce timeout pressure and queue buildup.
            "max_tokens": _NIM_MAX_TOKENS,
        }

        async with httpx.AsyncClient(timeout=_NIM_TIMEOUT) as client:
            for attempt in range(1, _NIM_MAX_RETRIES + 1):
                # Respect rate limit before making request
                await self._rate_limiter.acquire()
                
                started = time.perf_counter()
                logger.info("NIM request started | model=%s attempt=%d/%d", model, attempt, _NIM_MAX_RETRIES)
                try:
                    response = await client.post(url, headers=headers, json=payload)
                    response.raise_for_status()
                    data = response.json()
                    elapsed_ms = int((time.perf_counter() - started) * 1000)
                    logger.info("NIM request succeeded | model=%s attempt=%d elapsed_ms=%d", model, attempt, elapsed_ms)
                    return data["choices"][0]["message"]["content"]
                except httpx.TimeoutException as exc:
                    elapsed_ms = int((time.perf_counter() - started) * 1000)
                    logger.warning(
                        "NIM timeout for model %s (attempt %d/%d) elapsed_ms=%d: %s",
                        model,
                        attempt,
                        _NIM_MAX_RETRIES,
                        elapsed_ms,
                        exc,
                    )
                except httpx.HTTPStatusError as exc:
                    elapsed_ms = int((time.perf_counter() - started) * 1000)
                    status = exc.response.status_code
                    body = exc.response.text[:300]
                    logger.warning(
                        "NIM HTTP error %s for model %s (attempt %d/%d) elapsed_ms=%d: %s",
                        status,
                        model,
                        attempt,
                        _NIM_MAX_RETRIES,
                        elapsed_ms,
                        body,
                    )
                    # Retry rate-limited and transient upstream failures.
                    if status not in {429, 500, 502, 503, 504}:
                        logger.warning("NIM request aborted (non-retriable status) | model=%s status=%s", model, status)
                        return None
                except Exception as exc:
                    logger.warning("NIM call failed for model %s: %s", model, exc)
                    return None

                if attempt < _NIM_MAX_RETRIES:
                    # Exponential backoff: 2^attempt * 2 seconds (2s, 4s, 8s for attempts 1,2,3)
                    backoff_seconds = (2 ** attempt) * 2
                    logger.info("NIM retry scheduled | model=%s next_attempt=%d backoff_seconds=%d", model, attempt + 1, backoff_seconds)
                    await asyncio.sleep(backoff_seconds)

        logger.warning("NIM request exhausted retries | model=%s", model)
        return None
