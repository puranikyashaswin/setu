"""Helpers for voice WebSocket tests (signed session tokens)."""

from __future__ import annotations

import auth
from urllib.parse import urlencode


def voice_ws_path(user_id: str, *, session_id: str | None = None) -> str:
    """Build /ws/voice URL that works in both local and production-like CI envs."""
    token = auth.sign_session_token(user_id)
    params = {"user_id": user_id, "token": token}
    if session_id is not None:
        params["session_id"] = session_id
    return f"/ws/voice?{urlencode(params)}"
