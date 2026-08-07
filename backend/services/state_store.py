from __future__ import annotations

import json
import time
from typing import Any

import redis

from backend.utils.settings import settings


class StateStore:
    def __init__(self) -> None:
        self._redis: redis.Redis | None = None
        self._jobs_mem: dict[str, dict[str, Any]] = {}
        self._runs_mem: dict[str, dict[str, Any]] = {}
        self._result_cache_mem: dict[str, tuple[float, dict[str, Any]]] = {}
        if settings.redis_url:
            try:
                self._redis = redis.Redis.from_url(settings.redis_url, decode_responses=True)
                self._redis.ping()
            except Exception:
                self._redis = None

    def _set_json(self, key: str, value: dict[str, Any], ttl_seconds: int) -> None:
        if self._redis:
            self._redis.set(key, json.dumps(value), ex=ttl_seconds)
            return
        expiry = time.time() + ttl_seconds
        if key.startswith("job:"):
            self._jobs_mem[key[4:]] = {"value": value, "expiry": expiry}
        elif key.startswith("run:"):
            self._runs_mem[key[4:]] = {"value": value, "expiry": expiry}
        elif key.startswith("cache:"):
            self._result_cache_mem[key[6:]] = (expiry, value)

    def _get_json(self, key: str) -> dict[str, Any] | None:
        if self._redis:
            raw = self._redis.get(key)
            if not raw:
                return None
            try:
                parsed = json.loads(raw)
                return parsed if isinstance(parsed, dict) else None
            except json.JSONDecodeError:
                return None
        now = time.time()
        if key.startswith("job:"):
            item = self._jobs_mem.get(key[4:])
            if not item or item["expiry"] < now:
                self._jobs_mem.pop(key[4:], None)
                return None
            return item["value"]
        if key.startswith("run:"):
            item = self._runs_mem.get(key[4:])
            if not item or item["expiry"] < now:
                self._runs_mem.pop(key[4:], None)
                return None
            return item["value"]
        if key.startswith("cache:"):
            item = self._result_cache_mem.get(key[6:])
            if not item or item[0] < now:
                self._result_cache_mem.pop(key[6:], None)
                return None
            return item[1]
        return None

    def set_job(self, job_id: str, payload: dict[str, Any]) -> None:
        self._set_json(f"job:{job_id}", payload, settings.job_ttl_seconds)

    def get_job(self, job_id: str) -> dict[str, Any] | None:
        return self._get_json(f"job:{job_id}")

    def set_run(self, run_id: str, payload: dict[str, Any]) -> None:
        self._set_json(f"run:{run_id}", payload, settings.run_ttl_seconds)

    def get_run(self, run_id: str) -> dict[str, Any] | None:
        return self._get_json(f"run:{run_id}")

    def set_result_cache(self, cache_key: str, payload: dict[str, Any]) -> None:
        self._set_json(f"cache:{cache_key}", payload, settings.result_cache_ttl_seconds)

    def get_result_cache(self, cache_key: str) -> dict[str, Any] | None:
        return self._get_json(f"cache:{cache_key}")

