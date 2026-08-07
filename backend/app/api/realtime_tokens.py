"""Short-lived control-plane credentials for WebRTC voice sessions."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Header, HTTPException

from backend.app.realtime.livekit import (
    LiveKitConfig,
    LiveKitConfigurationError,
    issue_participant_token,
)
from backend.app.shared.protocol import RealtimeSessionRequest, RealtimeSessionResponse

router = APIRouter(prefix="/v1/realtime", tags=["realtime"])


def _secret() -> bytes:
    value = (os.getenv("SETU_REALTIME_TOKEN_SECRET") or "").strip()
    if not value:
        # A process-local value is safe for local development but intentionally
        # invalidates sessions on restart. Production must configure a secret.
        value = secrets.token_urlsafe(32)
        _secret.process_secret = value  # type: ignore[attr-defined]
    return value.encode("utf-8")


def _token_secret() -> bytes:
    configured = (os.getenv("SETU_REALTIME_TOKEN_SECRET") or "").strip()
    if configured:
        return configured.encode("utf-8")
    value = getattr(_secret, "process_secret", None)
    if not value:
        _secret()
        value = getattr(_secret, "process_secret")
    return value.encode("utf-8")


def issue_token(*, user_id: str, session_id: str, language: str, ttl_seconds: int = 60) -> tuple[str, datetime]:
    ttl = max(10, min(ttl_seconds, 120))
    expires_at = datetime.now(timezone.utc) + timedelta(seconds=ttl)
    payload = {
        "sub": user_id,
        "sid": session_id,
        "lang": language,
        "exp": int(expires_at.timestamp()),
        "scope": ["voice:connect", "voice:cancel"],
    }
    encoded = base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode()).rstrip(b"=")
    signature = hmac.new(_token_secret(), encoded, hashlib.sha256).digest()
    token = encoded.decode() + "." + base64.urlsafe_b64encode(signature).decode().rstrip("=")
    return token, expires_at


def verify_token(token: str) -> dict[str, Any]:
    try:
        encoded, signature = token.split(".", 1)
        expected = base64.urlsafe_b64encode(hmac.new(_token_secret(), encoded.encode(), hashlib.sha256).digest()).decode().rstrip("=")
        if not hmac.compare_digest(signature, expected):
            raise ValueError("signature")
        padded = encoded + "=" * (-len(encoded) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded))
        if int(payload["exp"]) <= int(time.time()):
            raise ValueError("expired")
        return payload
    except (ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=401, detail="Invalid or expired realtime token") from exc


def verify_session_token(token: str, *, user_id: str, session_id: str) -> dict[str, Any]:
    """Verify both cryptographic validity and the user/session boundary."""

    claims = verify_token(token)
    if claims.get("sub") != user_id or claims.get("sid") != session_id:
        raise HTTPException(status_code=403, detail="Realtime token is outside this session")
    return claims


def _ice_servers() -> list[dict[str, Any]]:
    raw = (os.getenv("WEBRTC_ICE_SERVERS_JSON") or "").strip()
    if not raw:
        return []
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError("WEBRTC_ICE_SERVERS_JSON must be valid JSON") from exc
    if not isinstance(value, list):
        raise RuntimeError("WEBRTC_ICE_SERVERS_JSON must be a JSON array")
    return value


@router.post("/sessions", response_model=RealtimeSessionResponse)
def create_realtime_session(
    body: RealtimeSessionRequest,
    x_user_id: str | None = Header(default=None),
) -> RealtimeSessionResponse:
    """Issue a short-lived LiveKit participant token; provider keys stay server-side."""

    # Compatibility adapter only: replace this header with the authenticated
    # mobile identity before production launch. It must not be user-controlled.
    user_id = (x_user_id or "").strip()
    if not user_id:
        raise HTTPException(status_code=401, detail="X-User-Id required")
    session_id = body.session_id or secrets.token_urlsafe(18)
    transport = (os.getenv("REALTIME_TRANSPORT") or "livekit").strip().lower()
    if transport == "mock":
        token, expires_at = issue_token(user_id=user_id, session_id=session_id, language=body.language)
        return RealtimeSessionResponse(
            sessionId=session_id,
            token=token,
            expiresAt=expires_at,
            transport="mock",
            iceServers=_ice_servers(),
        )
    if transport != "livekit":
        raise HTTPException(status_code=503, detail="Unsupported realtime transport")
    try:
        config = LiveKitConfig.from_environment()
        token, room_name = issue_participant_token(
            config=config,
            user_id=user_id,
            session_id=session_id,
            language=body.language,
        )
    except LiveKitConfigurationError as exc:
        raise HTTPException(status_code=503, detail="Realtime media service is not configured") from exc
    expires_at = datetime.now(timezone.utc) + timedelta(seconds=90)
    return RealtimeSessionResponse(
        sessionId=session_id,
        token=token,
        expiresAt=expires_at,
        transport="livekit",
        serverUrl=config.url,
        roomName=room_name,
    )
