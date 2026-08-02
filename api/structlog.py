"""Minimal structured JSON logging for production grepping."""

from __future__ import annotations

import json
import logging
import time
import uuid
from typing import Any

logger = logging.getLogger("setu.struct")


def new_request_id() -> str:
    return uuid.uuid4().hex[:12]


def log_event(event: str, **fields: Any) -> None:
    payload = {
        "ts": round(time.time(), 3),
        "event": event,
        **{k: v for k, v in fields.items() if v is not None},
    }
    logger.info(json.dumps(payload, ensure_ascii=False, default=str))
