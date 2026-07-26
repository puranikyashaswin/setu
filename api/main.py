"""Setu FastAPI backend — Vision at upload, fast /converse, verified /ask."""

from __future__ import annotations

import logging
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

import json
import threading

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field

import auth
import db
import sarvam

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("setu")

SAMPLES_DIR = Path(__file__).resolve().parent.parent / "samples"

# Demo docs — Vision runs at startup so /ask after pick is instant.
_SAMPLE_DEFS: list[dict] = [
    {
        "name": "Rythu Bharosa 2025",
        "description": (
            "Telangana G.O. guidelines for the Rythu Bharosa farmer "
            "investment support scheme (Telugu)."
        ),
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


# Onboarding languages judges are most likely to pick, warmed first.
_INTRO_WARM_LANGUAGES = ["en", "hi", "te", "kn", "ta", "mr"]


def _warm_intro_tts() -> None:
    """Synthesize the fixed intros once so the first user never waits ~6s for TTS."""
    for language in _INTRO_WARM_LANGUAGES:
        try:
            text = sarvam.intro_for_language(language)
            t0 = time.perf_counter()
            sarvam.speak(text, language)
            logger.info(
                "Warmed intro TTS language=%s in %.2fs", language, time.perf_counter() - t0
            )
        except Exception:
            logger.warning("Intro TTS warm failed language=%s", language, exc_info=True)


def _start_intro_tts_warm() -> None:
    if not os.getenv("SARVAM_API_KEY"):
        return
    threading.Thread(target=_warm_intro_tts, name="intro-tts-warm", daemon=True).start()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    db.init_db()
    sarvam.load_ocr_cache()
    sarvam.load_session_corrections()
    if not os.getenv("SARVAM_API_KEY"):
        logger.warning("SARVAM_API_KEY not set — API calls will fail")
    else:
        # Warm TLS/HTTP so the first /converse is not ~2s cold.
        try:
            t0 = time.perf_counter()
            sarvam.chat_reply("hi", "en", False)
            logger.info("Warmed /converse client in %.3fs", time.perf_counter() - t0)
        except Exception:
            logger.exception("Client warm-up failed")
    for sample in _SAMPLE_DEFS:
        path = SAMPLES_DIR / sample["file"]
        if not path.exists():
            logger.warning("Sample missing: %s", path)
            continue
        try:
            result = sarvam.extract_document(
                path.read_bytes(),
                sample["file"],
                language=sample["language"],
            )
            if result.get("status") == "unclear_scan":
                logger.warning("Sample OCR unclear: %s", sample["file"])
                continue
            sample["doc_id"] = result["doc_id"]
            logger.info(
                "Pre-cached sample %s -> %s (cached=%s)",
                sample["file"],
                sample["doc_id"][:12],
                result.get("cached"),
            )
        except Exception:
            logger.exception("Failed to pre-cache sample %s", sample["file"])
    _start_intro_tts_warm()
    yield


app = FastAPI(title="Setu API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_frontend_origins(),
    allow_origin_regex=r"https://.*\.vercel\.app",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


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
    return {"status": "ok"}


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
):
    """NDJSON stream: progress events, then a final done / unclear_scan / error line."""
    t0 = time.perf_counter()
    data = await file.read()
    if not data:
        raise HTTPException(400, "Empty file")
    filename = file.filename or "document.jpg"
    lang = language or "te-IN"

    def event_stream():
        vision_s = 0.0
        cached = None
        yield_buf: list[dict] = []
        result_holder: dict = {}
        error_holder: list[BaseException] = []
        t_vision = time.perf_counter()

        def run():
            try:
                result_holder["value"] = sarvam.extract_document(
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
            vision_s = time.perf_counter() - t_vision

            if error_holder:
                exc = error_holder[0]
                if isinstance(exc, ValueError):
                    status, detail = 400, str(exc)
                else:
                    logger.exception("scan failed")
                    status, detail = 502, f"Vision failed: {exc}"
                yield json.dumps({"type": "error", "detail": detail, "status": status}) + "\n"
                return

            result = result_holder["value"]
            cached = result.get("cached")
            if result.get("status") == "unclear_scan":
                yield json.dumps({"type": "unclear_scan", "status": "unclear_scan"}) + "\n"
                return
            yield json.dumps(
                {
                    "type": "done",
                    "doc_id": result["doc_id"],
                    "pages": result["pages"],
                    "cached": result["cached"],
                }
            ) + "\n"
        finally:
            logger.info(
                "[timing] /scan total=%.3fs vision=%.3fs cached=%s",
                time.perf_counter() - t0,
                vision_s,
                cached,
            )
            logger.info("[scan] vision=%.3fs", vision_s)

    return StreamingResponse(event_stream(), media_type="application/x-ndjson")


@app.post("/listen")
async def listen(
    file: UploadFile = File(...), language: str | None = Form(default=None)
):
    t0 = time.perf_counter()
    data = await file.read()
    if not data:
        raise HTTPException(400, "Empty audio")
    filename = file.filename or "audio.wav"
    try:
        return sarvam.listen(data, filename, language=language)
    except Exception as exc:
        logger.exception("listen failed")
        raise HTTPException(502, f"STT failed: {exc}") from exc
    finally:
        logger.info("[timing] /listen %.3fs", time.perf_counter() - t0)


@app.post("/converse")
def converse(body: ConverseBody):
    if not body.message.strip():
        raise HTTPException(400, "message required")
    t0 = time.perf_counter()
    try:
        # Only redirect to /ask when a document is actually loaded. With no document
        # an empty reply leaves the voice loop silent, so always answer instead.
        if body.has_document and not sarvam.is_converse_allowed(body.message):
            return {
                "redirect": True,
                "route_to": "ask",
                "intent": "document_question",
                "reply": "",
            }
        client_memory = (body.memory or "").strip()
        result = sarvam.chat_reply(
            body.message,
            body.language,
            body.has_document,
            history=[m.model_dump() for m in body.history],
            memory_context=client_memory or _memory_context(body.user_id, body.session_id),
        )
        return {
            "redirect": False,
            "route_to": None,
            "reply": result.get("reply", ""),
            "intent": result.get("intent", "chat"),
        }
    except Exception as exc:
        logger.exception("converse failed")
        raise HTTPException(502, f"Chat failed: {exc}") from exc
    finally:
        logger.info("[timing] /converse %.3fs", time.perf_counter() - t0)


@app.post("/ask")
def ask(body: AskBody):
    if not body.question.strip():
        raise HTTPException(400, "question required")
    t0 = time.perf_counter()
    doc = sarvam.get_document(body.doc_id)
    if not doc:
        logger.info("[timing] /ask %.3fs status=404", time.perf_counter() - t0)
        raise HTTPException(404, "Unknown doc_id — scan the document first")
    try:
        session_id = (body.session_id or "").strip()
        corrections = (
            sarvam.ingest_corrections_from_utterance(session_id, body.question)
            if session_id
            else []
        )
        result = sarvam.ask_document(
            doc["text"],
            body.question,
            body.answer_language,
            history=[m.model_dump() for m in body.history],
            corrections=corrections,
        )
        evidence = sarvam.verify_citations(result.get("evidence") or [], doc["text"])
        status = result.get("status", "not_found")
        if any(not item.get("verified") for item in evidence):
            if status == "verified_document":
                status = "not_found"
        all_verified = bool(evidence) and all(
            item.get("verified") for item in evidence
        ) and status == "verified_document"
        return {
            "answer": result.get("answer", ""),
            "language": result.get("language", body.answer_language),
            "status": status,
            "action_items": result.get("action_items") or [],
            "evidence": evidence,
            "abstain": bool(result.get("abstain", False)),
            "all_verified": all_verified,
            # User-stated facts — never merge into evidence / verification.
            "corrections": corrections,
        }
    except Exception as exc:
        logger.exception("ask failed")
        raise HTTPException(502, f"Ask failed: {exc}") from exc
    finally:
        logger.info("[timing] /ask %.3fs", time.perf_counter() - t0)


@app.post("/summarize")
def summarize(body: SummarizeBody):
    t0 = time.perf_counter()
    doc = sarvam.get_document(body.doc_id)
    if not doc:
        logger.info("[timing] /summarize %.3fs status=404", time.perf_counter() - t0)
        raise HTTPException(404, "Unknown doc_id — scan the document first")
    try:
        summary = sarvam.summarize_document(doc["text"], body.answer_language)
        return {"summary": summary}
    except Exception as exc:
        logger.exception("summarize failed")
        raise HTTPException(502, f"Summarize failed: {exc}") from exc
    finally:
        logger.info("[timing] /summarize %.3fs", time.perf_counter() - t0)


@app.post("/speak")
def speak(body: SpeakBody):
    if not body.text.strip():
        raise HTTPException(400, "text required")
    t0 = time.perf_counter()
    try:
        wav = sarvam.speak(
            body.text, body.language, speaker=body.speaker, pace=body.pace
        )
    except ValueError as exc:
        logger.error("[speak] bad request language=%s speaker=%s: %s", body.language, body.speaker, exc)
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:
        logger.exception("[speak] failed language=%s speaker=%s", body.language, body.speaker)
        raise HTTPException(502, f"TTS failed for {body.language}/{body.speaker}: {exc}") from exc
    finally:
        logger.info("[timing] /speak %.3fs language=%s", time.perf_counter() - t0, body.language)
    return Response(content=wav, media_type="audio/wav")
