"""Realtime voice WebSocket — persistent session, progressive TTS, barge-in cancel."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import time
import uuid
from collections import deque
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

import agent
import auth
import db
import rate_limit
import sarvam

logger = logging.getLogger("setu")

router = APIRouter()

# Ring buffer of recent WS voice events for GET /debug/last-turn.
_VOICE_EVENTS: deque[dict[str, Any]] = deque(maxlen=50)
_LAST_VOICE_SESSION: str | None = None
_PROCESS_BOOT_MS = int(time.time() * 1000)
_VOICE_ACTIVITY = False


def voice_log(session_id: str | None, event: str, **fields: Any) -> None:
    """One-line [voice] stage log + ring buffer (logging only; never raises)."""
    global _LAST_VOICE_SESSION, _VOICE_ACTIVITY
    _VOICE_ACTIVITY = True
    sid = str(session_id or "-")[:64] or "-"
    _LAST_VOICE_SESSION = sid
    parts = [f"[voice] session={sid} event={event}"]
    for key, value in fields.items():
        if value is None:
            continue
        if isinstance(value, str):
            safe = value.replace("\n", " ").replace('"', "'")
            if len(safe) > 120:
                safe = safe[:117] + "..."
            parts.append(f'{key}="{safe}"' if (" " in safe or not safe) else f"{key}={safe}")
        else:
            parts.append(f"{key}={value}")
    logger.info("%s", " ".join(parts))
    entry = {"ts_ms": int(time.time() * 1000), "session_id": sid, "event": event}
    for key, value in fields.items():
        if value is None:
            continue
        if isinstance(value, str) and len(value) > 200:
            entry[key] = value[:197] + "..."
        else:
            entry[key] = value
    _VOICE_EVENTS.append(entry)


def get_voice_events() -> list[dict[str, Any]]:
    return list(_VOICE_EVENTS)


def last_voice_session_id() -> str | None:
    return _LAST_VOICE_SESSION


def has_voice_activity() -> bool:
    """True once any WS voice event was logged in this process."""
    return _VOICE_ACTIVITY


def process_boot_ms() -> int:
    return _PROCESS_BOOT_MS


def reset_voice_debug_for_tests() -> None:
    """Test helper — clear ring without pretending the process restarted."""
    global _LAST_VOICE_SESSION, _VOICE_ACTIVITY
    _VOICE_EVENTS.clear()
    _LAST_VOICE_SESSION = None
    _VOICE_ACTIVITY = False


def _ws_url_user(websocket: WebSocket) -> str | None:
    user_id = websocket.headers.get("x-user-id") or websocket.query_params.get("user_id")
    return (user_id or "").strip() or None


async def _send(ws: WebSocket, payload: dict[str, Any]) -> None:
    await ws.send_text(json.dumps(payload, ensure_ascii=False))


@router.websocket("/ws/voice")
async def voice_socket(websocket: WebSocket):
    user_id = _ws_url_user(websocket)
    if not user_id:
        await websocket.close(code=4401)
        return
    try:
        auth.resolve_user(user_id)
        rate_limit.check_rate_limit(user_id, bucket="ai", limit=45, window_s=60.0)
    except Exception:
        await websocket.close(code=4401)
        return

    await websocket.accept()
    session: dict[str, Any] = {
        "language": "en",
        "has_document": False,
        "doc_id": None,
        "history": [],
        "memory": None,
        "session_id": None,
        "onboarded": False,
        "pace": 1.0,
    }

    def _history_from_turns(turns: list[dict]) -> list[dict]:
        out: list[dict] = []
        for turn in turns or []:
            role = turn.get("role")
            text = (turn.get("text") or "").strip()
            if not text:
                continue
            if role in ("setu", "assistant"):
                out.append({"role": "assistant", "content": text, "language": turn.get("language")})
            elif role == "user":
                out.append({"role": "user", "content": text, "language": turn.get("language")})
        return out[-12:]

    def _hydrate_from_db(session_id: str) -> bool:
        loaded = db.get_session(session_id, user_id)
        if not loaded:
            return False
        session["session_id"] = loaded["id"]
        session["language"] = loaded.get("language") or "en"
        session["doc_id"] = loaded.get("doc_id")
        session["has_document"] = bool(loaded.get("doc_id"))
        session["onboarded"] = bool(loaded.get("onboarded"))
        session["history"] = _history_from_turns(loaded.get("turns") or [])
        return True

    def _resolve_persisted_session() -> str:
        """Create/load the real session UUID before any voice_log call."""
        requested = (websocket.query_params.get("session_id") or "").strip()
        if requested and _hydrate_from_db(requested):
            return str(session["session_id"])
        created = db.upsert_session(
            {
                "id": requested or None,
                "user_id": user_id,
                "title": "New chat",
                "language": "en",
                "onboarded": False,
                "turns": [],
            }
        )
        sid_value = str(created.get("id") or uuid.uuid4())
        session["session_id"] = sid_value
        return sid_value

    persisted_session_id = _resolve_persisted_session()
    cancel_event = asyncio.Event()
    turn_lock = asyncio.Lock()

    def sid() -> str:
        return str(session.get("session_id") or persisted_session_id)

    voice_log(sid(), "ws_connect")
    await _send(
        websocket,
        {"type": "ready", "user_id": user_id, "session_id": sid()},
    )

    async def run_turn(audio_b64: str, force_route: str | None = None) -> None:
        cancel_event.clear()
        t0 = time.perf_counter()
        stage = "stt"
        try:
            rate_limit.check_rate_limit(user_id, bucket="ai", limit=45, window_s=60.0)
        except Exception as exc:
            voice_log(sid(), "error", stage=stage, detail=str(getattr(exc, "detail", exc)))
            await _send(websocket, {"type": "error", "message": str(getattr(exc, "detail", exc))})
            return

        try:
            audio = base64.b64decode(audio_b64)
        except Exception:
            voice_log(sid(), "error", stage=stage, detail="Invalid audio payload")
            await _send(websocket, {"type": "error", "message": "Invalid audio payload"})
            return
        if not audio:
            voice_log(sid(), "error", stage=stage, detail="Empty audio")
            await _send(websocket, {"type": "error", "message": "Empty audio"})
            return
        try:
            rate_limit.enforce_size(audio, max_bytes=rate_limit.MAX_AUDIO_BYTES, label="audio")
        except Exception as exc:
            voice_log(sid(), "error", stage=stage, detail=str(getattr(exc, "detail", exc)))
            await _send(websocket, {"type": "error", "message": str(getattr(exc, "detail", exc))})
            return

        await _send(websocket, {"type": "status", "stage": "stt", "text": "Hearing you"})
        voice_log(sid(), "stt_start", source="server")
        t_stt = time.perf_counter()

        try:
            stt = await asyncio.to_thread(sarvam.listen, audio, "setu-question.wav", None)
        except Exception as exc:
            logger.exception("ws STT failed")
            voice_log(sid(), "error", stage="stt", detail=str(exc))
            await _send(websocket, {"type": "error", "message": f"STT failed: {exc}"})
            return

        if cancel_event.is_set():
            voice_log(sid(), "barge_in_fired")
            await _send(websocket, {"type": "cancelled"})
            return

        transcript = (stt.get("transcript") or "").strip()
        language_code = stt.get("language_code") or ""
        voice_log(
            sid(),
            "stt_done",
            ms=int((time.perf_counter() - t_stt) * 1000),
            text=transcript,
            language=language_code or session.get("language") or "",
        )
        await _send(
            websocket,
            {
                "type": "transcript",
                "text": transcript,
                "language_code": language_code,
            },
        )
        if not transcript:
            voice_log(sid(), "error", stage="stt", detail="empty transcript")
            await _send(websocket, {"type": "error", "message": "I could not understand that. Try again."})
            return

        await _send(websocket, {"type": "status", "stage": "think", "text": "Thinking"})
        stage = "route"
        memory = (session.get("memory") or "").strip() or None
        try:
            result = await asyncio.to_thread(
                agent.run_agent_turn,
                transcript,
                language=session.get("language") or "en",
                has_document=bool(session.get("has_document")),
                doc_id=session.get("doc_id"),
                history=session.get("history") or [],
                memory=memory,
                session_id=session.get("session_id") or sid(),
                onboarded=bool(session.get("onboarded")),
                force_route=force_route,
                use_tools=True,
                stt_language_code=language_code or None,
            )
        except Exception as exc:
            logger.exception("ws agent failed")
            voice_log(sid(), "error", stage="route", detail=str(exc))
            await _send(websocket, {"type": "error", "message": f"Agent failed: {exc}"})
            return

        if cancel_event.is_set():
            voice_log(sid(), "barge_in_fired")
            await _send(websocket, {"type": "cancelled"})
            return

        if result.tools_used:
            await _send(websocket, {"type": "tool", "name": result.tools_used[0], "status": "done"})

        # Persist language from the agent result first (language_switch / intro / chat).
        session["language"] = (result.language or session.get("language") or "en").split("-", 1)[0]
        if result.route in ("intro", "language_switch"):
            session["onboarded"] = True
        try:
            db.upsert_session(
                {
                    "id": sid(),
                    "user_id": user_id,
                    "title": "Chat",
                    "language": session["language"],
                    "doc_id": session.get("doc_id"),
                    "onboarded": session["onboarded"],
                }
            )
        except Exception:
            logger.warning("voice session persist failed", exc_info=True)

        await _send(
            websocket,
            {
                "type": "status",
                "stage": "tts",
                "text": "Preparing a response",
                "route": result.route,
            },
        )

        stage = "tts"
        parts = result.spoken_parts or [sarvam.spoken_text(result.reply, result.max_spoken) or result.reply]
        voice_log(sid(), "tts_start")
        t_tts = time.perf_counter()
        audio_chunks: list[str] = []
        part_index = 0
        for index, part in enumerate(parts):
            if cancel_event.is_set():
                voice_log(sid(), "barge_in_fired")
                await _send(websocket, {"type": "cancelled"})
                return
            if not (part or "").strip():
                continue
            try:
                wav = await asyncio.to_thread(
                    sarvam.speak,
                    part,
                    result.language,
                    "shubh",
                    float(session.get("pace") or 1.0),
                )
            except Exception as exc:
                logger.exception("ws TTS failed")
                voice_log(sid(), "error", stage="tts", detail=str(exc))
                await _send(websocket, {"type": "error", "message": f"TTS failed: {exc}"})
                return
            b64 = base64.b64encode(wav).decode("ascii")
            audio_chunks.append(b64)
            part_index += 1
            voice_log(sid(), "audio_part_sent", part=part_index, bytes=len(wav))
            await _send(
                websocket,
                {
                    "type": "audio",
                    "audio_base64": b64,
                    "audio_mime": "audio/wav",
                    "index": index,
                    "text": part,
                    "final": index == len(parts) - 1,
                },
            )

        voice_log(
            sid(),
            "tts_done",
            ms=int((time.perf_counter() - t_tts) * 1000),
            parts=len(audio_chunks),
        )

        spoken = " ".join(p.strip() for p in parts if p.strip()) or result.reply
        combined_b64 = audio_chunks[0] if len(audio_chunks) == 1 else (audio_chunks[0] if audio_chunks else "")
        # Prefer first chunk for immediate play; client plays streamed chunks in order.
        await _send(
            websocket,
            {
                "type": "turn.done",
                "transcript": transcript,
                "language_code": stt.get("language_code"),
                "language": result.language,
                "route": result.route,
                "intent": result.intent,
                "reply": result.reply,
                "spoken": spoken,
                "open_camera": result.open_camera,
                "continue_listening": result.continue_listening,
                "model_used": result.model_used,
                "ask": result.ask,
                "tools_used": result.tools_used,
                "audio_base64": combined_b64,
                "audio_mime": "audio/wav",
                "audio_parts": len(audio_chunks),
                "elapsed_ms": int((time.perf_counter() - t0) * 1000),
            },
        )

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                voice_log(sid(), "error", stage="route", detail="Invalid JSON")
                await _send(websocket, {"type": "error", "message": "Invalid JSON"})
                continue
            msg_type = msg.get("type")
            if msg_type == "ping":
                await _send(websocket, {"type": "pong"})
                continue
            if msg_type == "cancel":
                cancel_event.set()
                voice_log(sid(), "barge_in_fired")
                await _send(websocket, {"type": "cancelled"})
                continue
            if msg_type == "session.update":
                incoming_sid = (msg.get("session_id") or "").strip()
                if incoming_sid and incoming_sid != session.get("session_id"):
                    if not _hydrate_from_db(incoming_sid):
                        session["session_id"] = incoming_sid
                for key in (
                    "language",
                    "has_document",
                    "doc_id",
                    "history",
                    "memory",
                    "onboarded",
                    "pace",
                ):
                    if key in msg:
                        session[key] = msg[key]
                await _send(websocket, {"type": "session.updated", "session": {
                    "language": session["language"],
                    "has_document": session["has_document"],
                    "doc_id": session["doc_id"],
                    "onboarded": session["onboarded"],
                    "session_id": session["session_id"],
                }})
                continue
            if msg_type == "audio.utterance":
                if turn_lock.locked():
                    cancel_event.set()
                    voice_log(sid(), "barge_in_fired")
                    # Wait briefly for prior turn to notice cancel.
                    await asyncio.sleep(0.05)
                async with turn_lock:
                    await run_turn(msg.get("audio_base64") or "", force_route=msg.get("force_route"))
                continue
            voice_log(sid(), "error", stage="route", detail=f"Unknown message type: {msg_type}")
            await _send(websocket, {"type": "error", "message": f"Unknown message type: {msg_type}"})
    except WebSocketDisconnect as exc:
        code = getattr(exc, "code", None)
        reason = getattr(exc, "reason", None) or ""
        voice_log(sid(), "ws_disconnect", code=code if code is not None else "", reason=str(reason))
    except Exception as exc:
        logger.exception("voice ws crashed")
        voice_log(sid(), "error", stage="route", detail=str(exc))
        try:
            await websocket.close(code=1011)
        except Exception:
            pass
        voice_log(sid(), "ws_disconnect", code=1011, reason="server_error")
