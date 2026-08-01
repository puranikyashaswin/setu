"""Realtime voice WebSocket — persistent session, progressive TTS, barge-in cancel."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import time
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

import agent
import auth
import rate_limit
import sarvam

logger = logging.getLogger("setu")

router = APIRouter()


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
    cancel_event = asyncio.Event()
    turn_lock = asyncio.Lock()

    await _send(websocket, {"type": "ready", "user_id": user_id})

    async def run_turn(audio_b64: str, force_route: str | None = None) -> None:
        cancel_event.clear()
        t0 = time.perf_counter()
        try:
            rate_limit.check_rate_limit(user_id, bucket="ai", limit=45, window_s=60.0)
        except Exception as exc:
            await _send(websocket, {"type": "error", "message": str(getattr(exc, "detail", exc))})
            return

        try:
            audio = base64.b64decode(audio_b64)
        except Exception:
            await _send(websocket, {"type": "error", "message": "Invalid audio payload"})
            return
        if not audio:
            await _send(websocket, {"type": "error", "message": "Empty audio"})
            return
        try:
            rate_limit.enforce_size(audio, max_bytes=rate_limit.MAX_AUDIO_BYTES, label="audio")
        except Exception as exc:
            await _send(websocket, {"type": "error", "message": str(getattr(exc, "detail", exc))})
            return

        await _send(websocket, {"type": "status", "stage": "stt", "text": "Hearing you"})

        try:
            stt = await asyncio.to_thread(sarvam.listen, audio, "setu-question.wav", None)
        except Exception as exc:
            logger.exception("ws STT failed")
            await _send(websocket, {"type": "error", "message": f"STT failed: {exc}"})
            return

        if cancel_event.is_set():
            await _send(websocket, {"type": "cancelled"})
            return

        transcript = (stt.get("transcript") or "").strip()
        await _send(
            websocket,
            {
                "type": "transcript",
                "text": transcript,
                "language_code": stt.get("language_code") or "",
            },
        )
        if not transcript:
            await _send(websocket, {"type": "error", "message": "I could not understand that. Try again."})
            return

        await _send(websocket, {"type": "status", "stage": "think", "text": "Thinking"})

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
                session_id=session.get("session_id"),
                onboarded=bool(session.get("onboarded")),
                force_route=force_route,
                use_tools=True,
            )
        except Exception as exc:
            logger.exception("ws agent failed")
            await _send(websocket, {"type": "error", "message": f"Agent failed: {exc}"})
            return

        if cancel_event.is_set():
            await _send(websocket, {"type": "cancelled"})
            return

        if result.tools_used:
            await _send(websocket, {"type": "tool", "name": result.tools_used[0], "status": "done"})

        session["language"] = result.language
        if result.route == "intro":
            session["onboarded"] = True

        await _send(
            websocket,
            {
                "type": "status",
                "stage": "tts",
                "text": "Preparing a response",
                "route": result.route,
            },
        )

        parts = result.spoken_parts or [sarvam.spoken_text(result.reply, result.max_spoken) or result.reply]
        audio_chunks: list[str] = []
        for index, part in enumerate(parts):
            if cancel_event.is_set():
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
                await _send(websocket, {"type": "error", "message": f"TTS failed: {exc}"})
                return
            b64 = base64.b64encode(wav).decode("ascii")
            audio_chunks.append(b64)
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
                await _send(websocket, {"type": "error", "message": "Invalid JSON"})
                continue
            msg_type = msg.get("type")
            if msg_type == "ping":
                await _send(websocket, {"type": "pong"})
                continue
            if msg_type == "cancel":
                cancel_event.set()
                await _send(websocket, {"type": "cancelled"})
                continue
            if msg_type == "session.update":
                for key in (
                    "language",
                    "has_document",
                    "doc_id",
                    "history",
                    "memory",
                    "session_id",
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
                    # Wait briefly for prior turn to notice cancel.
                    await asyncio.sleep(0.05)
                async with turn_lock:
                    await run_turn(msg.get("audio_base64") or "", force_route=msg.get("force_route"))
                continue
            await _send(websocket, {"type": "error", "message": f"Unknown message type: {msg_type}"})
    except WebSocketDisconnect:
        logger.info("voice ws disconnected user=%s", user_id[:8])
    except Exception:
        logger.exception("voice ws crashed")
        try:
            await websocket.close(code=1011)
        except Exception:
            pass
