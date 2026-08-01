"""Setu FastAPI backend — Vision at upload, fast /converse, verified /ask, one-shot /voice."""

from __future__ import annotations

import asyncio
import base64
import logging
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

import json
import threading

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field

import agent
import auth
import db
import ocr
import rate_limit
import sarvam
import voice_ws

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("setu")

SAMPLES_DIR = Path(__file__).resolve().parent.parent / "samples"

# Last request stage timings for GET /debug/last-turn.
_LAST_TURN: dict = {}

# Optional sample metadata for /samples UI. OCR runs only when a user selects/uploads.
_SAMPLE_DEFS: list[dict] = [
    {
        "name": "Sample notice",
        "description": "Optional demo document (OCR only after you select it).",
        "file": "notice.jpg",
        "language": "te-IN",
        "doc_id": None,
    },
]


def _frontend_origins() -> list[str]:
    origins = ["http://localhost:3000"]
    extra = os.getenv("FRONTEND_ORIGIN") or os.getenv("CORS_ORIGINS")
    if extra:
        for part in extra.split(","):
            part = part.strip()
            if part and part not in origins:
                origins.append(part)
    return origins


def _ensure_data_dirs() -> None:
    """Create DB parent + CACHE_PATH so SQLite/OCR/TTS survive on a mounted disk."""
    cache_dir = Path(os.getenv("CACHE_PATH") or "./cache/")
    cache_dir.mkdir(parents=True, exist_ok=True)
    db_path = Path(os.getenv("DB_PATH") or os.getenv("SETU_DB_PATH") or "./cache/setu.db")
    db_path.parent.mkdir(parents=True, exist_ok=True)
    logger.info("Data paths db=%s cache=%s", db_path.resolve(), cache_dir.resolve())


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
    return auth.resolve_user(x_user_id)


def _require_ai_user(user_id: str = Depends(rate_limit.require_user_id)) -> str:
    rate_limit.check_rate_limit(user_id, bucket="ai", limit=45, window_s=60.0)
    return user_id


def _warm_fixed_tts() -> None:
    """Synthesize fixed phrases in parallel so first turns never wait on cold TTS."""
    phrases = sarvam.fixed_warm_phrases()
    # Deduplicate while preserving order.
    seen: set[tuple[str, str]] = set()
    unique: list[tuple[str, str]] = []
    for text, language in phrases:
        key = (text, language)
        if key in seen or not text.strip():
            continue
        seen.add(key)
        unique.append(key)

    def _one(item: tuple[str, str]) -> None:
        text, language = item
        t0 = time.perf_counter()
        sarvam.speak(text, language)
        logger.info(
            "Warm-up complete: TTS language=%s chars=%s in %.2fs",
            language,
            len(text),
            time.perf_counter() - t0,
        )

    with ThreadPoolExecutor(max_workers=4, thread_name_prefix="tts-warm") as pool:
        futures = [pool.submit(_one, item) for item in unique]
        for fut in as_completed(futures):
            try:
                fut.result()
            except Exception:
                logger.warning("TTS warm item failed", exc_info=True)
    logger.info("Warm-up complete: intro-TTS")


def _warm_client() -> None:
    t0 = time.perf_counter()
    sarvam.chat_reply("hi", "en", False)
    logger.info("Warm-up complete: converse client in %.3fs", time.perf_counter() - t0)


def _hydrate_sample_ids_from_cache() -> None:
    """Bind sample doc_ids from existing OCR disk/db cache only — never call Vision."""
    import hashlib

    for sample in _SAMPLE_DEFS:
        path = SAMPLES_DIR / sample["file"]
        if not path.exists():
            continue
        try:
            file_hash = hashlib.sha256(path.read_bytes()).hexdigest()
            lang = sample["language"]
            doc_id = hashlib.sha256(f"{file_hash}:{lang}".encode()).hexdigest()
            if sarvam.get_document(doc_id):
                sample["doc_id"] = doc_id
                logger.info("Hydrated sample %s from cache -> %s", sample["file"], doc_id[:12])
        except Exception:
            logger.warning("Sample cache hydrate failed for %s", sample["file"], exc_info=True)


async def _warmup_background() -> None:
    """Intro TTS + converse client only — never OCR/Vision. Failures log only."""
    loop = asyncio.get_running_loop()

    async def _one(label: str, fn) -> None:
        try:
            await loop.run_in_executor(None, fn)
        except Exception:
            logger.warning("Warm-up failed: %s", label, exc_info=True)

    await _one("intro-TTS", _warm_fixed_tts)
    await _one("converse client", _warm_client)
    logger.info("Warm-up complete: all items")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    _ensure_data_dirs()
    db.init_db()
    sarvam.load_ocr_cache()
    sarvam.load_session_corrections()
    _hydrate_sample_ids_from_cache()
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


app = FastAPI(title="Setu API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_frontend_origins(),
    allow_origin_regex=r"https://.*\.vercel\.app",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

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
    return {
        "status": "ok",
        "ocr_provider": ocr.resolve_ocr_provider(),
        "openrouter_configured": bool((os.getenv("OPENROUTER_API_KEY") or "").strip()),
    }


@app.get("/debug/last-turn")
def debug_last_turn():
    """Last REST stage timings + last WS voice event ring (up to 50)."""
    payload = dict(_LAST_TURN) if _LAST_TURN else {}
    payload["voice_session_id"] = voice_ws.last_voice_session_id()
    payload["voice_events"] = voice_ws.get_voice_events()
    return payload


@app.get("/warm")
def warm():
    """Keep-alive that also touches the Sarvam client so TLS stays hot."""
    if not os.getenv("SARVAM_API_KEY"):
        return {"status": "ok", "warmed": False}
    try:
        # Cheap fixed-phrase TTS hits disk/memory cache after first warm.
        sarvam.speak(sarvam.brief_ack_for_language("en"), "en")
        return {"status": "ok", "warmed": True}
    except Exception:
        logger.warning("warm ping failed", exc_info=True)
        return {"status": "ok", "warmed": False}


@app.post("/auth/guest")
def auth_guest(body: GuestBody):
    user = auth.resolve_user(body.user_id)
    return {"user_id": user["id"], "email": user.get("email"), "is_guest": bool(user.get("is_guest", 1))}


@app.post("/auth/magic-link")
def auth_magic_link(body: MagicLinkBody):
    try:
        return auth.request_magic_link(body.email, body.user_id)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.post("/auth/magic-verify")
def auth_magic_verify(body: MagicVerifyBody):
    user = auth.verify_magic_link(body.token)
    if not user:
        raise HTTPException(400, "Invalid or expired sign-in link")
    return {"user_id": user["id"], "email": user.get("email"), "is_guest": bool(user.get("is_guest", 0))}


@app.post("/intro")
def intro(body: IntroBody):
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


@app.get("/voices")
def voices():
    return sarvam.v3_speakers()


@app.get("/samples")
def samples():
    return [
        {
            "doc_id": s["doc_id"],
            "name": s["name"],
            "description": s["description"],
        }
        for s in _SAMPLE_DEFS
        if s.get("doc_id")
    ]


@app.post("/scan")
async def scan(
    file: UploadFile = File(...),
    language: str | None = Form(default=None),
    user_id: str = Depends(_require_ai_user),
):
    """NDJSON stream: progress events, then a final done / unclear_scan / error line."""
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
        yield_buf: list[dict] = []
        result_holder: dict = {}
        error_holder: list[BaseException] = []
        t_ocr = time.perf_counter()

        def run():
            try:
                result_holder["value"] = ocr.extract_document(
                    data,
                    filename,
                    language=lang,
                    progress=lambda event: yield_buf.append(event),
                )
            except BaseException as exc:  # noqa: BLE001 — forwarded as NDJSON error
                error_holder.append(exc)

        try:
            worker = threading.Thread(target=run, daemon=True)
            worker.start()
            cursor = 0
            while worker.is_alive() or cursor < len(yield_buf):
                while cursor < len(yield_buf):
                    event = yield_buf[cursor]
                    cursor += 1
                    yield json.dumps(event, ensure_ascii=False) + "\n"
                if worker.is_alive():
                    time.sleep(0.15)
            worker.join()
            ocr_ms = _ms_since(t_ocr)

            if error_holder:
                exc = error_holder[0]
                if isinstance(exc, ValueError):
                    http_status, detail = 400, str(exc)
                else:
                    logger.error("scan failed: %s", exc, exc_info=exc)
                    http_status, detail = 502, sarvam._friendly_vision_error(exc)
                yield json.dumps({"type": "error", "detail": detail, "status": http_status}) + "\n"
                return

            result = result_holder["value"]
            cached = result.get("cached")
            if result.get("status") == "unclear_scan":
                yield json.dumps({"type": "unclear_scan", "status": "unclear_scan"}) + "\n"
                return
            preview = (result.get("preview") or (result.get("text") or "")[:500]).strip()
            yield json.dumps(
                {
                    "type": "done",
                    "doc_id": result["doc_id"],
                    "pages": result["pages"],
                    "cached": result["cached"],
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
        )
        if not (result.reply or "").strip():
            result.reply = sarvam.camera_phrase(result.language, "show")
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
    _ = user_id
    route_ms = 0
    llm_ms = 0
    status = 200
    t_route = time.perf_counter()
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
    except ValueError as exc:
        status = 400
        logger.error("[speak] bad request language=%s speaker=%s: %s", body.language, body.speaker, exc)
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:
        status = 502
        logger.exception("[speak] failed language=%s speaker=%s", body.language, body.speaker)
        raise HTTPException(502, f"TTS failed for {body.language}/{body.speaker}: {exc}") from exc
    finally:
        _record_timing("/speak", status, tts_ms=tts_ms, total_ms=_ms_since(t0))
    return Response(content=wav, media_type="audio/wav")
