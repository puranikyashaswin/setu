"""Optional Sentry bootstrap with transcript-safe event scrubbing."""

from __future__ import annotations

import logging
import os
from typing import Any

logger = logging.getLogger("setu.observability")

_INITIALIZED = False
_SENSITIVE_KEYS = {
    "audio",
    "audio_base64",
    "body",
    "document",
    "file",
    "message",
    "prompt",
    "query",
    "reply",
    "text",
    "transcript",
}


def _scrub(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: "[Filtered]" if key.lower() in _SENSITIVE_KEYS else _scrub(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_scrub(item) for item in value]
    return value


def _before_send(event: dict[str, Any], _hint: dict[str, Any]) -> dict[str, Any]:
    """Remove voice/document content before it can leave the API process."""
    event["request"] = _scrub(event.get("request", {}))
    event["extra"] = _scrub(event.get("extra", {}))
    event["contexts"] = _scrub(event.get("contexts", {}))
    return event


def init_sentry() -> bool:
    """Configure Sentry when SENTRY_DSN is set; otherwise remain a no-op."""
    global _INITIALIZED
    if _INITIALIZED:
        return True

    dsn = (os.getenv("SENTRY_DSN") or "").strip()
    if not dsn:
        logger.info("Sentry disabled: SENTRY_DSN is unset")
        return False

    try:
        import sentry_sdk
    except ImportError:
        logger.warning("Sentry disabled: install sentry-sdk to enable SENTRY_DSN")
        return False

    sentry_sdk.init(
        dsn=dsn,
        environment=os.getenv("SENTRY_ENVIRONMENT") or os.getenv("ENVIRONMENT") or "production",
        send_default_pii=False,
        before_send=_before_send,
    )
    _INITIALIZED = True
    logger.info("Sentry initialized")
    return True
