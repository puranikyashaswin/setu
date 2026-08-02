"""Setu FastAPI backend — Vision at upload, fast /converse, verified /ask, one-shot /voice."""

from __future__ import annotations

import asyncio
import base64
import hmac
import logging
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

import json
import queue
import threading

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

import agent
import auth
import db
import ocr
import observability
import paths
import rate_limit
import sarvam
import settings
import structlog
import voice_ws

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("setu")

# Last request stage timings for GET /debug/last-turn.
_LAST_TURN: dict = {}


def _frontend_origins() -> list[str]:
    origins = ["http://localhost:3000"]
    extra = os.getenv("FRONTEND_ORIGIN") or os.getenv("CORS_ORIGINS")
    if extra:
        for part in extra.split(","):
            part = part.strip()
            if part and part not in origins:
                origins.append(part)
    return origins


def _allow_vercel_preview_cors() -> bool:
    """Preview wildcard is off in production unless explicitly enabled."""
    flag = (os.getenv("ALLOW_VERCEL_PREVIEWS") or "").strip().lower()
    if flag in {"1", "true", "yes"}:
        return True
    if flag in {"0", "false", "no"}:
        return False
    return not db.is_production()


def _ms_since(t0: float) -> int:
    return int((time.perf_counter() - t0) * 1000)


def _record_timing(route: str, status: int, **stages_ms: int) -> None:
    """Log one [timing] line and stash it for /debug/last-turn."""
    order = ("stt_ms", "route_ms", "llm_ms", "tts_ms", "ocr_ms", "total_ms")
    parts = [f"route={route}"]
    for key in order:
        if key in stages_ms:
            parts.append(f"{key}={int(stages_ms[key])}")
    parts.append(f"status={status}")
    logger.info("[timing] %s", " ".join(parts))
    structlog.log_event(
        "timing",
        request_id=structlog.new_request_id(),
        route=route,
        status=status,
        **{k: int(v) for k, v in stages_ms.items()},
    )
    global _LAST_TURN
    _LAST_TURN = {"route": route, "status": status, **{k: int(v) for k, v in stages_ms.items()}}


def _memory_context(user_id: str | None, session_id: str | None = None) -> str | None:
    """Digest of the user's recent chats, including real turns so Setu can recall them."""
    if not user_id:
        return None
    recent = db.recent_session_digests(user_id, exclude_session_id=session_id, limit=4)
    if not recent:
        return None
    blocks: list[str] = []
    for index, item in enumerate(recent, start=1):
        header = f"Earlier chat {index}: {item.get('title') or 'Chat'}"
        if item.get("document_name"):
            header += f" (document: {item['document_name']})"
        lines = [header]
        if item.get("summary"):
            lines.append(f"  summary: {item['summary']}")
        for turn in item.get("turns") or []:
            speaker = "User" if turn["role"] == "user" else "Setu"
            text = turn["text"]
            if len(text) > 180:
                text = text[:180].rstrip() + "…"
            lines.append(f"  {speaker}: {text}")
        blocks.append("\n".join(lines))
    return "\n".join(blocks)


def _user_from_header(x_user_id: str | None) -> dict:
    """Require an existing client identity — do not mint guests from a missing header.

    Guests are created only via POST /auth/guest (or magic-link verify).
    """
    if not x_user_id or not str(x_user_id).strip():
        raise HTTPException(status_code=401, detail="X-User-Id required")
    return auth.resolve_user(str(x_user_id).strip())


def _require_ai_user(user_id: str = Depends(rate_limit.require_user_id)) -> str:
    rate_limit.check_rate_limit(user_id, bucket="ai", limit=45, window_s=60.0)
    return user_id


def _warm_client() -> None:
    """HTTP/LLM client touch only — must never call Bulbul TTS."""
    t0 = time.perf_counter()
    sarvam.chat_reply("hi", "en", False)
    logger.info("Warm-up complete: converse client in %.3fs", time.perf_counter() - t0)


async def _warmup_background() -> None:
    """No TTS at startup (avoids 429). Optional LLM client warm only."""
    logger.info("[warmup] tts_skipped=true reason=avoid_rate_limit")
    loop = asyncio.get_running_loop()
    try:
        await loop.run_in_executor(None, _warm_client)
    except Exception:
        logger.warning("Warm-up failed: converse client", exc_info=True)
    logger.info("Warm-up complete: client-only")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    settings.require_production_settings()
    observability.init_sentry()
    db_path, cache_dir = paths.ensure_data_dirs()
    logger.info("Data paths db=%s cache=%s", db_path.resolve(), cache_dir.resolve())
    db.init_db()
    sarvam.load_ocr_cache()
    sarvam.load_session_corrections()
    origins = _frontend_origins()
    print(f"[startup] CORS allow_origins={origins}", flush=True)
    logger.info("CORS allow_origins=%s", origins)
    warm_task: asyncio.Task | None = None
    if not os.getenv("SARVAM_API_KEY"):
        logger.warning("SARVAM_API_KEY not set — API calls will fail")
    else:
        # Schedule warm-up then yield immediately so /health is not blocked.
        warm_task = asyncio.create_task(_warmup_background())
    yield
    if warm_task is not None and not warm_task.done():
        warm_task.cancel()
        try:
            await warm_task
        except asyncio.CancelledError:
            pass


_docs_url = None if db.is_production() else "/docs"
_redoc_url = None if db.is_production() else "/redoc"
app = FastAPI(
    title="Setu API",
    lifespan=lifespan,
    docs_url=_docs_url,
    redoc_url=_redoc_url,
    openapi_url=None if db.is_production() else "/openapi.json",
)

_cors_kwargs: dict = {
    "allow_origins": _frontend_origins(),
    "allow_credentials": True,
    "allow_methods": ["*"],
    "allow_headers": ["*"],
}
if _allow_vercel_preview_cors():
    _cors_kwargs["allow_origin_regex"] = r"https://.*\.vercel\.app"

app.add_middleware(CORSMiddleware, **_cors_kwargs)
# Trust X-Forwarded-* from Render's reverse proxy (scheme/host for redirects & cookies).
app.add_middleware(ProxyHeadersMiddleware, trusted_hosts="*")

app.include_router(voice_ws.router)


class HistoryMessage(BaseModel):
    role: str
    content: str
    language: str | None = None


class ConverseBody(BaseModel):
    message: str
    language: str = "en"
    has_document: bool = False
    history: list[HistoryMessage] = Field(default_factory=list)
    session_id: str | None = None
    user_id: str | None = None
    # The browser keeps every chat in IndexedDB. On a host with an ephemeral disk the
    # server database can be empty, so the client's own digest is the reliable source.
    memory: str | None = Field(default=None, max_length=6000)


class AskBody(BaseModel):
    doc_id: str
    question: str
    answer_language: str = "en"
    session_id: str | None = None
    user_id: str | None = None
    history: list[HistoryMessage] = Field(default_factory=list)


class GuestBody(BaseModel):
    user_id: str | None = None


class MagicLinkBody(BaseModel):
    email: str
    user_id: str | None = None


class MagicVerifyBody(BaseModel):
    token: str


class IntroBody(BaseModel):
    language: str = "en"


class SessionUpsertBody(BaseModel):
    id: str | None = None
    title: str = "New chat"
    language: str = "en"
    doc_id: str | None = None
    document_name: str | None = None
    summary: str | None = None
    onboarded: bool = False
    created_at: float | None = None
    turns: list[dict] = Field(default_factory=list)


class SummarizeBody(BaseModel):
    doc_id: str
    answer_language: str = "en"


class SpeakBody(BaseModel):
    text: str
    language: str = "en"
    speaker: str = Field(default="shubh")
    pace: float = Field(default=1.0, ge=0.5, le=2.0)


@app.get("/health")
def health():
    """Liveness. Includes db flag — degraded when SQLite is unusable."""
    db_ok = True
    db_error: str | None = None
    try:
        # Read-only on the hot keep-warm path; writable check runs at boot + /ready.
        db.check_readable()
    except Exception as exc:  # noqa: BLE001 — surface any disk/SQLite failure
        db_ok = False
        db_error = type(exc).__name__
        logger.error("health db check failed: %s", exc)
    status = "ok" if db_ok else "degraded"
    body = {
        "status": status,
        "db": "ok" if db_ok else "error",
        "ocr_provider": ocr.resolve_ocr_provider(),
        "openrouter_configured": bool((os.getenv("OPENROUTER_API_KEY") or "").strip()),
    }
    if db_error:
        body["db_error"] = db_error
    if not db_ok:
        raise HTTPException(status_code=503, detail=body)
    return body


@app.get("/ready")
def ready():
    """Readiness: DB writable + required secrets present (stricter than /health)."""
    errors: list[str] = []
    try:
        db.check_writable()
    except Exception as exc:  # noqa: BLE001
        errors.append(f"db:{type(exc).__name__}")
    if not (os.getenv("SARVAM_API_KEY") or "").strip():
        errors.append("sarvam_api_key")
    if db.is_production() and not (os.getenv("AUTH_SECRET") or "").strip():
        errors.append("auth_secret")
    if db.is_production() and not (os.getenv("DB_PATH") or os.getenv("SETU_DB_PATH") or "").strip():
        errors.append("db_path")
    if errors:
        raise HTTPException(status_code=503, detail={"status": "not_ready", "errors": errors})
    return {"status": "ready", "db": "ok"}


def _require_debug_access(x_debug_token: str | None) -> None:
    """Gate /debug in production with DEBUG_TOKEN; open locally when unset."""
    expected = (os.getenv("DEBUG_TOKEN") or "").strip()
    if db.is_production():
        if not expected:
            raise HTTPException(404, "Not found")
        if not x_debug_token or not hmac.compare_digest(x_debug_token, expected):
            raise HTTPException(404, "Not found")
        return
    if expected and (not x_debug_token or not hmac.compare_digest(x_debug_token, expected)):
        raise HTTPException(401, "X-Debug-Token required")


@app.get("/debug/last-turn")
def debug_last_turn(x_debug_token: str | None = Header(default=None, alias="X-Debug-Token")):
    """Last REST stage timings + last WS voice event ring (up to 50).

    Survives client disconnect for the life of the process. Right after boot
    (no voice activity yet) returns note=server_restarted so null is not
    confused with a client mic bug. Production requires DEBUG_TOKEN.
    """
    _require_debug_access(x_debug_token)
    payload = dict(_LAST_TURN) if _LAST_TURN else {}
    payload["voice_session_id"] = voice_ws.last_voice_session_id()
    payload["voice_events"] = voice_ws.get_voice_events()
    payload["process_boot_ms"] = voice_ws.process_boot_ms()
    if (
        not _LAST_TURN
        and payload["voice_session_id"] is None
        and not payload["voice_events"]
        and not voice_ws.has_voice_activity()
    ):
        payload["note"] = "server_restarted"
    return payload


@app.get("/warm")
def warm():
    """Keep-alive ping — touch HTTP client only; never Bulbul TTS."""
    if not os.getenv("SARVAM_API_KEY"):
        return {"status": "ok", "warmed": False, "tts_skipped": True}
    try:
        sarvam.get_client()
        return {"status": "ok", "warmed": True, "tts_skipped": True}
    except Exception:
        logger.warning("warm ping failed", exc_info=True)
        return {"status": "ok", "warmed": False, "tts_skipped": True}


def _session_cookie_response(payload: dict, user_id: str) -> JSONResponse:
    """Attach HttpOnly signed session cookie + body token (for cross-origin WS)."""
    token = auth.sign_session_token(user_id)
    body = {**payload, "session_token": token}
    response = JSONResponse(body)
    secure = db.is_production()
    response.set_cookie(
        key=auth.SESSION_COOKIE,
        value=token,
        httponly=True,
        secure=secure,
        samesite="lax",
        max_age=60 * 60 * 24 * 180,
        path="/",
    )
    return response


@app.post("/auth/guest")
def auth_guest(body: GuestBody):
    user = auth.resolve_user(body.user_id)
    return _session_cookie_response(
        {"user_id": user["id"], "email": user.get("email"), "is_guest": bool(user.get("is_guest", 1))},
        user["id"],
    )


@app.post("/auth/magic-link")
def auth_magic_link(body: MagicLinkBody, request: Request):
    ip = request.client.host if request.client else "unknown"
    rate_limit.check_rate_limit(ip, bucket="magic_ip", limit=10, window_s=3600.0)
    rate_limit.check_rate_limit(body.email.strip().lower(), bucket="magic_email", limit=5, window_s=3600.0)
    try:
        return auth.request_magic_link(body.email, body.user_id)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.post("/auth/magic-verify")
def auth_magic_verify(body: MagicVerifyBody):
    user = auth.verify_magic_link(body.token)
    if not user:
        raise HTTPException(400, "Invalid or expired sign-in link")
    return _session_cookie_response(
        {"user_id": user["id"], "email": user.get("email"), "is_guest": bool(user.get("is_guest", 0))},
        user["id"],
    )


@app.post("/intro")
def intro(body: IntroBody, user_id: str = Depends(_require_ai_user)):
    _ = user_id
    try:
        text = sarvam.intro_for_language(body.language)
        return {"text": text, "language": body.language}
    except Exception as exc:
        logger.exception("intro failed")
        raise HTTPException(502, f"Intro failed: {exc}") from exc


@app.get("/sessions")
def sessions_list(x_user_id: str | None = Header(default=None)):
    user = _user_from_header(x_user_id)
    items = db.list_sessions(user["id"], limit=20)
    return {
        "user_id": user["id"],
        "sessions": [
            {
                "id": item["id"],
                "title": item["title"],
                "language": item["language"],
                "docId": item.get("doc_id"),
                "documentName": item.get("document_name"),
                "summary": item.get("summary"),
                "onboarded": bool(item.get("onboarded")),
                "createdAt": item["created_at"] * 1000,
                "updatedAt": item["updated_at"] * 1000,
            }
            for item in items
        ],
    }


@app.get("/sessions/{session_id}")
def sessions_get(session_id: str, x_user_id: str | None = Header(default=None)):
    user = _user_from_header(x_user_id)
    session = db.get_session(session_id, user["id"])
    if not session:
        raise HTTPException(404, "Session not found")
    return {
        "id": session["id"],
        "title": session["title"],
        "language": session["language"],
        "docId": session.get("doc_id"),
        "documentName": session.get("document_name"),
        "summary": session.get("summary"),
        "onboarded": bool(session.get("onboarded")),
        "createdAt": session["created_at"] * 1000,
        "updatedAt": session["updated_at"] * 1000,
        "turns": session.get("turns") or [],
        "corrections": [],
    }


@app.put("/sessions/{session_id}")
def sessions_put(session_id: str, body: SessionUpsertBody, x_user_id: str | None = Header(default=None)):
    user = _user_from_header(x_user_id)
    payload = body.model_dump()
    payload["id"] = session_id
    payload["user_id"] = user["id"]
    if payload.get("created_at") and payload["created_at"] > 10_000_000_000:
        payload["created_at"] = payload["created_at"] / 1000
    try:
        session = db.upsert_session(payload)
    except PermissionError:
        raise HTTPException(403, "Session belongs to a different user") from None
    return {"ok": True, "id": session.get("id"), "user_id": user["id"]}


@app.delete("/sessions/{session_id}")
def sessions_delete(session_id: str, x_user_id: str | None = Header(default=None)):
    user = _user_from_header(x_user_id)
    db.delete_session(session_id, user["id"])
    return {"ok": True}


@app.delete("/auth/account")
def auth_delete_account(x_user_id: str | None = Header(default=None)):
    """Delete the caller's account data (sessions, turns, owned documents)."""
    user = _user_from_header(x_user_id)
    counts = db.delete_user_data(user["id"])
    response = JSONResponse({"ok": True, "deleted": counts})
    response.delete_cookie(auth.SESSION_COOKIE, path="/")
    return response


@app.get("/voices")
def voices(user_id: str = Depends(_require_ai_user)):
    _ = user_id
    return sarvam.v3_speakers()


@app.post("/scan")
async def scan(
    file: UploadFile = File(...),
    language: str | None = Form(default=None),
    user_id: str = Depends(_require_ai_user),
):
    """NDJSON stream: progress events, then a final done / timeout / unclear_scan / error line."""
    t0 = time.perf_counter()
    data = await file.read()
    if not data:
        raise HTTPException(400, "Empty file")
    rate_limit.enforce_size(data, max_bytes=rate_limit.MAX_SCAN_BYTES, label="document")
    filename = file.filename or "document.jpg"
    lang = language or "te-IN"
    _ = user_id

    def event_stream():
        ocr_ms = 0
        http_status = 200
        cached = None
        events: queue.Queue = queue.Queue()
        t_ocr = time.perf_counter()

        def run():
            try:
                result = ocr.extract_document(
                    data,
                    filename,
                    language=lang,
                    progress=lambda event: events.put(event),
                )
                events.put({"type": "_result", "value": result})
            except BaseException as exc:  # noqa: BLE001 — forwarded as NDJSON error
                events.put({"type": "_exception", "exc": exc})

        try:
            worker = threading.Thread(target=run, daemon=True)
            worker.start()
            result = None
            while True:
                try:
                    event = events.get(timeout=0.2)
                except queue.Empty:
                    if worker.is_alive():
                        continue
                    try:
                        event = events.get_nowait()
                    except queue.Empty:
                        break

                etype = event.get("type")
                if etype == "_result":
                    result = event["value"]
                    break
                if etype == "_exception":
                    exc = event["exc"]
                    if isinstance(exc, ValueError):
                        http_status, detail = 400, str(exc)
                    else:
                        logger.error("scan failed: %s", exc, exc_info=exc)
                        http_status, detail = 502, sarvam._friendly_vision_error(exc)
                    yield json.dumps(
                        {"type": "error", "detail": detail, "status": http_status}
                    ) + "\n"
                    return
                yield json.dumps(event, ensure_ascii=False) + "\n"

            worker.join(timeout=0.1)
            ocr_ms = _ms_since(t_ocr)

            if result is None:
                http_status = 502
                yield json.dumps(
                    {
                        "type": "error",
                        "detail": "Document analysis failed. Please retry.",
                        "status": http_status,
                    }
                ) + "\n"
                return

            cached = result.get("cached")
            status = result.get("status")
            if status == "timeout":
                http_status = 504
                yield json.dumps(
                    {
                        "type": "timeout",
                        "detail": result.get("detail") or sarvam.OCR_TIMEOUT_DETAIL,
                        "doc_id": result.get("doc_id"),
                    }
                ) + "\n"
                return
            if status == "error":
                http_status = 502
                yield json.dumps(
                    {
                        "type": "error",
                        "detail": result.get("detail")
                        or "Document analysis failed. Please retry with a clearer photo.",
                        "doc_id": result.get("doc_id"),
                    }
                ) + "\n"
                return
            if status == "unclear_scan":
                yield json.dumps({"type": "unclear_scan", "status": "unclear_scan"}) + "\n"
                return
            preview = (result.get("preview") or (result.get("text") or "")[:500]).strip()
            yield json.dumps(
                {
                    "type": "done",
                    "doc_id": result["doc_id"],
                    "pages": result["pages"],
                    "cached": result.get("cached", False),
                    "provider": result.get("provider") or ocr.resolve_ocr_provider(),
                    "preview": preview,
                }
            ) + "\n"
        finally:
            _record_timing(
                "/scan",
                http_status,
                ocr_ms=ocr_ms,
                total_ms=_ms_since(t0),
            )
            logger.info("[scan] ocr_ms=%s cached=%s", ocr_ms, cached)

    return StreamingResponse(event_stream(), media_type="application/x-ndjson")


@app.post("/listen")
async def listen(
    file: UploadFile = File(...),
    language: str | None = Form(default=None),
    user_id: str = Depends(_require_ai_user),
):
    t0 = time.perf_counter()
    data = await file.read()
    if not data:
        raise HTTPException(400, "Empty audio")
    rate_limit.enforce_size(data, max_bytes=rate_limit.MAX_AUDIO_BYTES, label="audio")
    filename = file.filename or "audio.wav"
    _ = user_id
    stt_ms = 0
    status = 200
    try:
        t_stt = time.perf_counter()
        result = sarvam.listen(data, filename, language=language)
        stt_ms = _ms_since(t_stt)
        return result
    except Exception as exc:
        status = 502
        logger.exception("listen failed")
        raise HTTPException(502, f"STT failed: {exc}") from exc
    finally:
        _record_timing("/listen", status, stt_ms=stt_ms, total_ms=_ms_since(t0))


@app.post("/voice")
async def voice(
    file: UploadFile = File(...),
    language: str = Form(default="en"),
    has_document: bool = Form(default=False),
    doc_id: str | None = Form(default=None),
    session_id: str | None = Form(default=None),
    history: str = Form(default="[]"),
    memory: str | None = Form(default=None),
    onboarded: bool = Form(default=False),
    speaker: str = Form(default="shubh"),
    pace: float = Form(default=1.0),
    force_route: str | None = Form(default=None),
    transcript: str | None = Form(default=None),
    user_id: str = Depends(_require_ai_user),
):
    """One-shot STT → route → LLM → TTS. Returns transcript, reply metadata, and WAV."""
    t0 = time.perf_counter()
    data = await file.read()
    browser_transcript = (transcript or "").strip()
    if not data and not browser_transcript:
        raise HTTPException(400, "Empty audio")
    if data:
        rate_limit.enforce_size(data, max_bytes=rate_limit.MAX_AUDIO_BYTES, label="audio")
    filename = file.filename or "audio.wav"

    try:
        history_msgs = json.loads(history) if history else []
        if not isinstance(history_msgs, list):
            history_msgs = []
    except json.JSONDecodeError:
        history_msgs = []

    language_code = ""
    if browser_transcript:
        # Chrome Web Speech already heard the user — skip server STT latency.
        heard = browser_transcript
    else:
        try:
            stt = sarvam.listen(data, filename, language=None)
        except Exception as exc:
            logger.exception("voice STT failed")
            raise HTTPException(502, f"STT failed: {exc}") from exc
        heard = (stt.get("transcript") or "").strip()
        language_code = stt.get("language_code") or ""

    if not heard:
        raise HTTPException(400, "I could not understand that. Try again.")
    transcript = heard

    result: agent.AgentResult | None = None
    spoken = ""
    wav = b""
    audio_parts_b64: list[str] = []
    try:
        result = agent.run_agent_turn(
            transcript,
            language=language,
            has_document=has_document,
            doc_id=doc_id,
            history=history_msgs,
            memory=(memory or "").strip() or _memory_context(user_id, session_id),
            session_id=session_id,
            onboarded=onboarded,
            force_route=force_route,
            use_tools=True,
            stt_language_code=language_code or None,
        )
        if not (result.reply or "").strip():
            result.reply = agent.ensure_speakable_reply(
                "", result.language or language, context="voice_http"
            )
        spoken = sarvam.spoken_text(result.reply, result.max_spoken)
        # Demo: one consistent voice — ignore client speaker switches.
        wav, parts = agent.synthesize_turn_audio(result, pace=pace)
        audio_parts_b64 = [base64.b64encode(p).decode("ascii") for p in parts]
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("voice pipeline failed")
        raise HTTPException(502, f"Voice turn failed: {exc}") from exc
    finally:
        logger.info(
            "[timing] /voice %.3fs route=%s model=%s tools=%s",
            time.perf_counter() - t0,
            result.route if result else None,
            result.model_used if result else None,
            result.tools_used if result else None,
        )

    assert result is not None
    return {
        "transcript": transcript,
        "language_code": language_code,
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
        "audio_base64": base64.b64encode(wav).decode("ascii"),
        "audio_mime": "audio/wav",
        "audio_parts_base64": audio_parts_b64,
        "user_id": user_id,
    }


@app.post("/converse")
def converse(body: ConverseBody, user_id: str = Depends(_require_ai_user)):
    if not body.message.strip():
        raise HTTPException(400, "message required")
    t0 = time.perf_counter()
    effective_user = body.user_id or user_id
    route_ms = 0
    llm_ms = 0
    status = 200
    try:
        # Only redirect to /ask when a document is actually loaded. With no document
        # an empty reply leaves the voice loop silent, so always answer instead.
        t_route = time.perf_counter()
        redirect = body.has_document and not sarvam.is_converse_allowed(body.message)
        route_ms = _ms_since(t_route)
        if redirect:
            return {
                "redirect": True,
                "route_to": "ask",
                "intent": "document_question",
                "reply": "",
            }
        client_memory = (body.memory or "").strip()
        t_llm = time.perf_counter()
        result = sarvam.chat_reply(
            body.message,
            body.language,
            body.has_document,
            history=[m.model_dump() for m in body.history],
            memory_context=client_memory or _memory_context(effective_user, body.session_id),
        )
        llm_ms = _ms_since(t_llm)
        return {
            "redirect": False,
            "route_to": None,
            "reply": result.get("reply", ""),
            "intent": result.get("intent", "chat"),
            "model_used": "sarvam-105b",
        }
    except Exception as exc:
        status = 502
        logger.exception("converse failed")
        raise HTTPException(502, f"Chat failed: {exc}") from exc
    finally:
        _record_timing(
            "/converse",
            status,
            route_ms=route_ms,
            llm_ms=llm_ms,
            total_ms=_ms_since(t0),
        )


@app.post("/ask")
def ask(body: AskBody, user_id: str = Depends(_require_ai_user)):
    if not body.question.strip():
        raise HTTPException(400, "question required")
    t0 = time.perf_counter()
    route_ms = 0
    llm_ms = 0
    status = 200
    t_route = time.perf_counter()
    if not db.user_owns_document(body.doc_id, user_id):
        # Fall through to in-memory/sample docs that are not yet in SQLite.
        stored = db.get_document_text(body.doc_id)
        if stored is not None:
            route_ms = _ms_since(t_route)
            status = 403
            _record_timing("/ask", status, route_ms=route_ms, llm_ms=0, total_ms=_ms_since(t0))
            raise HTTPException(403, "Document belongs to another user")
    doc = sarvam.get_document(body.doc_id)
    if not doc:
        route_ms = _ms_since(t_route)
        status = 404
        _record_timing(
            "/ask",
            status,
            route_ms=route_ms,
            llm_ms=0,
            total_ms=_ms_since(t0),
        )
        raise HTTPException(404, "Unknown doc_id — scan the document first")
    try:
        session_id = (body.session_id or "").strip()
        corrections = (
            sarvam.ingest_corrections_from_utterance(session_id, body.question)
            if session_id
            else []
        )
        from doc_retrieve import retrieve_chunks

        context = retrieve_chunks(doc["text"], body.question)
        route_ms = _ms_since(t_route)
        t_llm = time.perf_counter()
        result = sarvam.ask_document(
            context or doc["text"],
            body.question,
            body.answer_language,
            history=[m.model_dump() for m in body.history],
            corrections=corrections,
        )
        llm_ms = _ms_since(t_llm)
        evidence = sarvam.verify_citations(result.get("evidence") or [], doc["text"])
        answer_status = result.get("status", "not_found")
        if any(not item.get("verified") for item in evidence):
            if answer_status == "verified_document":
                answer_status = "not_found"
        all_verified = bool(evidence) and all(
            item.get("verified") for item in evidence
        ) and answer_status == "verified_document"
        return {
            "answer": result.get("answer", ""),
            "language": result.get("language", body.answer_language),
            "status": answer_status,
            "action_items": result.get("action_items") or [],
            "evidence": evidence,
            "abstain": bool(result.get("abstain", False)),
            "all_verified": all_verified,
            "corrections": corrections,
            "model_used": result.get("model_used"),
        }
    except Exception as exc:
        status = 502
        logger.exception("ask failed")
        raise HTTPException(502, f"Ask failed: {exc}") from exc
    finally:
        if status != 404:
            _record_timing(
                "/ask",
                status,
                route_ms=route_ms,
                llm_ms=llm_ms,
                total_ms=_ms_since(t0),
            )


@app.post("/summarize")
def summarize(body: SummarizeBody, user_id: str = Depends(_require_ai_user)):
    t0 = time.perf_counter()
    _ = user_id
    llm_ms = 0
    status = 200
    doc = sarvam.get_document(body.doc_id)
    if not doc:
        status = 404
        _record_timing("/summarize", status, llm_ms=0, total_ms=_ms_since(t0))
        raise HTTPException(404, "Unknown doc_id — scan the document first")
    try:
        t_llm = time.perf_counter()
        summary = sarvam.summarize_document(doc["text"], body.answer_language)
        llm_ms = _ms_since(t_llm)
        return {"summary": summary, "model_used": "sarvam-105b"}
    except Exception as exc:
        status = 502
        logger.exception("summarize failed")
        raise HTTPException(502, f"Summarize failed: {exc}") from exc
    finally:
        if status != 404:
            _record_timing("/summarize", status, llm_ms=llm_ms, total_ms=_ms_since(t0))


@app.post("/speak")
def speak(body: SpeakBody, user_id: str = Depends(_require_ai_user)):
    if not body.text.strip():
        raise HTTPException(400, "text required")
    t0 = time.perf_counter()
    _ = user_id
    tts_ms = 0
    status = 200
    try:
        t_tts = time.perf_counter()
        wav = sarvam.speak(
            body.text, body.language, speaker=body.speaker, pace=body.pace
        )
        tts_ms = _ms_since(t_tts)
        if not wav:
            status = 502
            raise HTTPException(502, "TTS returned empty audio")
    except ValueError as exc:
        status = 400
        logger.error("[speak] bad request language=%s speaker=%s: %s", body.language, body.speaker, exc)
        raise HTTPException(400, str(exc)) from exc
    except sarvam.TtsError as exc:
        status = 502
        logger.error(
            "[speak] tts error language=%s speaker=%s status=%s: %s",
            body.language,
            body.speaker,
            exc.status,
            exc,
        )
        raise HTTPException(502, f"TTS failed for {body.language}/{body.speaker}: {exc}") from exc
    except HTTPException:
        raise
    except Exception as exc:
        status = 502
        logger.exception("[speak] failed language=%s speaker=%s", body.language, body.speaker)
        raise HTTPException(502, f"TTS failed for {body.language}/{body.speaker}: {exc}") from exc
    finally:
        _record_timing("/speak", status, tts_ms=tts_ms, total_ms=_ms_since(t0))
    return Response(content=wav, media_type="audio/wav")
