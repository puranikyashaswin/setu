"""LiveKit room-token adapter.

LiveKit is the media plane. The native app receives only the room URL, room
name, and a short-lived participant JWT; the LiveKit API secret and Sarvam key
remain server-side.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import dataclass
from datetime import timedelta


class LiveKitConfigurationError(RuntimeError):
    """Raised when production cannot create a safe room credential."""


@dataclass(frozen=True)
class LiveKitConfig:
    url: str
    api_key: str
    api_secret: str
    agent_name: str = "setu-voice"

    @classmethod
    def from_environment(cls) -> "LiveKitConfig":
        url = (os.getenv("LIVEKIT_URL") or "").strip()
        key = (os.getenv("LIVEKIT_API_KEY") or "").strip()
        secret = (os.getenv("LIVEKIT_API_SECRET") or "").strip()
        if not url or not key or not secret:
            raise LiveKitConfigurationError(
                "LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET are required"
            )
        if not url.startswith(("ws://", "wss://")):
            raise LiveKitConfigurationError("LIVEKIT_URL must start with ws:// or wss://")
        environment = (os.getenv("SETU_ENV") or "development").strip().lower()
        if environment in {"staging", "production"} and not url.startswith("wss://"):
            raise LiveKitConfigurationError("LIVEKIT_URL must use wss:// outside development")
        return cls(
            url=url,
            api_key=key,
            api_secret=secret,
            agent_name=(os.getenv("LIVEKIT_AGENT_NAME") or "setu-voice").strip(),
        )


def room_name_for_session(session_id: str, user_id: str = "") -> str:
    """Return a namespaced room id with opaque user/session segments."""

    namespace = (os.getenv("SETU_ROOM_NAMESPACE") or "setu-dev").strip()
    namespace = re.sub(r"[^A-Za-z0-9_-]+", "-", namespace).strip("-") or "setu-dev"
    user_digest = hashlib.sha256(user_id.encode("utf-8")).hexdigest()[:12]
    session_digest = hashlib.sha256(session_id.encode("utf-8")).hexdigest()[:12]
    return f"{namespace}-user_{user_digest}-session_{session_digest}"


def issue_participant_token(
    *,
    config: LiveKitConfig,
    user_id: str,
    session_id: str,
    language: str,
    ttl_seconds: int = 90,
) -> tuple[str, str]:
    """Create a participant token scoped to one room and one identity."""

    try:
        from livekit import api
    except ImportError as exc:  # pragma: no cover - exercised in deployment
        raise LiveKitConfigurationError("Install livekit-api for LiveKit transport") from exc

    room_name = room_name_for_session(session_id, user_id)
    ttl = max(30, min(ttl_seconds, 180))
    token = (
        api.AccessToken(config.api_key, config.api_secret)
        .with_identity(user_id)
        .with_name("Setu mobile")
        .with_metadata(json.dumps({"session_id": session_id, "language": language}))
        .with_ttl(timedelta(seconds=ttl))
        .with_grants(
            api.VideoGrants(
                room_join=True,
                room=room_name,
                can_publish=True,
                can_subscribe=True,
                can_publish_data=True,
            )
        )
    )
    if config.agent_name:
        token = token.with_room_config(
            api.RoomConfiguration(
                agents=[api.RoomAgentDispatch(agent_name=config.agent_name)],
            )
        )
    return token.to_jwt(), room_name
