"""Simple in-process rate limits for demo abuse protection."""

from __future__ import annotations

import threading
import time
from collections import defaultdict, deque

from fastapi import Header, HTTPException

# Per-user sliding window: max N requests per window seconds.
_LOCK = threading.Lock()
_HITS: dict[str, deque[float]] = defaultdict(deque)

DEFAULT_LIMIT = 60
DEFAULT_WINDOW_S = 60.0
MAX_AUDIO_BYTES = 3 * 1024 * 1024  # 3 MB
MAX_SCAN_BYTES = 12 * 1024 * 1024  # 12 MB


def require_user_id(x_user_id: str | None = Header(default=None, alias="X-User-Id")) -> str:
    user_id = (x_user_id or "").strip()
    if not user_id:
        raise HTTPException(401, "X-User-Id header required")
    return user_id


def check_rate_limit(
    user_id: str,
    *,
    bucket: str = "default",
    limit: int = DEFAULT_LIMIT,
    window_s: float = DEFAULT_WINDOW_S,
) -> None:
    key = f"{bucket}:{user_id}"
    now = time.monotonic()
    with _LOCK:
        q = _HITS[key]
        while q and now - q[0] > window_s:
            q.popleft()
        if len(q) >= limit:
            raise HTTPException(429, "Too many requests — wait a moment and try again")
        q.append(now)


def enforce_size(data: bytes, *, max_bytes: int, label: str = "upload") -> None:
    if len(data) > max_bytes:
        raise HTTPException(413, f"{label} too large (max {max_bytes // (1024 * 1024)}MB)")
