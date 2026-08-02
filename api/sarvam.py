"""Sarvam API helpers for Setu. Logic reused from sarvam_reference.py."""

from __future__ import annotations

import base64
import hashlib
import io
import json
import logging
import os
import re
import tempfile
import threading
import time
import zipfile
from collections import OrderedDict
from pathlib import Path

logger = logging.getLogger("setu")

import httpx
from dotenv import load_dotenv
from sarvamai import SarvamAI
from sarvamai.core.api_error import ApiError

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

_cache: dict[str, dict] = {}
# Prefer CACHE_PATH (Render disk: /data/cache). Relative default is CWD (api/ on Render).
_CACHE_DIR = Path(os.getenv("CACHE_PATH") or "./cache/")
_CACHE_FILE = _CACHE_DIR / "ocr_cache.json"
_CORRECTIONS_FILE = _CACHE_DIR / "session_corrections.json"
# session_id -> field -> {field, value, timestamp}
_session_corrections: dict[str, dict[str, dict]] = {}
_FORMAT_EXT = {"pdf": ".pdf", "png": ".png", "jpeg": ".jpg"}

_LANG_NAMES = {
    "te": "Telugu",
    "hi": "Hindi",
    "en": "English",
    "mr": "Marathi",
    "ta": "Tamil",
    "kn": "Kannada",
    "bn": "Bengali",
    "gu": "Gujarati",
    "ml": "Malayalam",
    "pa": "Punjabi",
    "or": "Odia",
}

# bulbul:v3 only — v2 names must never be sent
_V3_SPEAKERS = frozenset(
    {
        "aditya",
        "ritu",
        "ashutosh",
        "priya",
        "neha",
        "rahul",
        "pooja",
        "rohan",
        "simran",
        "kavya",
        "amit",
        "dev",
        "ishita",
        "shreya",
        "ratan",
        "varun",
        "manan",
        "sumit",
        "roopa",
        "kabir",
        "aayan",
        "shubh",
        "advait",
        "anand",
        "tanya",
        "tarun",
        "sunny",
        "mani",
        "gokul",
        "vijay",
        "shruti",
        "suhani",
        "mohit",
        "kavitha",
        "rehan",
        "soham",
        "rupali",
        "niharika",
    }
)
_V2_SPEAKERS = frozenset(
    {"anushka", "abhilash", "manisha", "vidya", "arya", "karun", "hitesh"}
)

# Rough signals that the user is asking about document content (route to /ask).
_DOC_QUESTION_RE = re.compile(
    r"(eligib|last\s*date|deadline|due\s*date|how\s*much|amount|scheme|notice|"
    r"form\b|page\s*\d|criteria|benefit|office|procedure|process|apply|"
    r"document|fee|required|qualif|deadline|when\s+is|where\s+(do|can|is)|"
    r"what\s+(is|does|are)\s+(the|this|my)|how\s+(do|can|much|many)|"
    r"पात्र|तारीख|राशि|योजना|कार्यालय|प्रक्रिया|"
    r"నోటీసు|తేదీ|ఎంత|పథకం|యోగ్య|కార్యాలయ)",
    re.I,
)
_NEEDS_DOC_RE = re.compile(
    r"(help\s*(me\s*)?(with\s*)?(this\s*)?(doc|document|paper|notice)|scan|"
    r"read\s*(this|my)|show\s*(you\s*)?(my\s*)?(doc|document|paper)|"
    r"दस्तावेज|काग[ज़ज]|नोटिस|స్కాన్)",
    re.I,
)
# Only these may hit sarvam-105b via /converse. Everything else redirects to /ask.
_CONVERSE_ALLOW_RE = re.compile(
    r"(^\s*(hi+|hello|hey|namaste|namaskar|హలో|नमस्ते|नमस्कार)\b|"
    r"\b(thanks|thank\s*you|thx|bye|goodbye|ok|okay|cool|great)\b|"
    r"धन्यवाद|ధన్యవాద|"
    r"who\s+are\s+you|what\s+(are|is)\s+(you|setu)|what\s+can\s+you\s+do|"
    r"your\s+name|about\s+setu|how\s+do\s+you\s+work)",
    re.I,
)

_ANSWER_SCHEMA = {
    "name": "answer_contract",
    "strict": True,
    "schema": {
        "type": "object",
        "properties": {
            "answer": {"type": "string", "maxLength": 600},
            "language": {"type": "string"},
            "status": {
                "type": "string",
                "enum": ["verified_document", "not_found", "unclear_scan"],
            },
            "action_items": {
                "type": "array",
                "maxItems": 5,
                "items": {"type": "string", "maxLength": 200},
            },
            "evidence": {
                "type": "array",
                "maxItems": 3,
                "items": {
                    "type": "object",
                    "properties": {
                        "page": {"type": "integer"},
                        "quote": {"type": "string", "maxLength": 400},
                    },
                    "required": ["page", "quote"],
                    "additionalProperties": False,
                },
            },
            "abstain": {"type": "boolean"},
        },
        "required": ["answer", "language", "status", "action_items", "evidence", "abstain"],
        "additionalProperties": False,
    },
}

def _ask_system_prompt(answer_language: str) -> str:
    language_name = _language_name(answer_language)
    return f"""CRITICAL: Your entire answer must be in {language_name} only (native script). Never reply in English unless the answer language is English. Set the language field to "{answer_language.split("-", 1)[0]}".

You are Setu, a fast voice assistant. Answer from the scanned text/image ONLY when the user asks about it.
User-stated corrections (if provided) are personal facts from the user — NOT document content. Use them to personalize answers when relevant. NEVER put them in evidence quotes; evidence must stay verbatim from the scan only.
Rules:
1. Use ONLY the scanned text for facts about it. Never invent. Do not label it as a government notice unless the text itself says that.
2. For "what is this / summarize / explain" questions: answer briefly from the scan with status="verified_document" and abstain=false.
3. Only abstain (status="not_found", abstain=true) when a SPECIFIC fact the user asked for is genuinely absent.
4. When abstaining, say what is missing in one short sentence in {language_name}.
5. Every evidence.quote must be copied verbatim from the scanned text.
6. Keep answer to at most 2 short spoken sentences. Be direct — no long overviews.
7. When status is verified_document, include 1–3 short verbatim evidence quotes with page numbers. When abstaining, evidence must be empty.
8. action_items: only if the user needs a concrete next step from the text; otherwise [].

CRITICAL: The answer field MUST be in {language_name} only. Never English unless the answer language is English."""


def _lang_code(language: str) -> str:
    """Normalize to Sarvam BCP-47 codes (Odia is od-IN, not or-IN)."""
    raw = (language or "en").strip()
    if "-" in raw:
        base, region = raw.split("-", 1)
        base = base.lower()
        if base == "or":
            base = "od"
        return f"{base}-{region}"
    base = raw.lower()
    if base == "or":
        base = "od"
    return f"{base}-IN"


def _tts_to_wav(resp) -> bytes:
    combined = b""
    for i, chunk in enumerate(resp.audios):
        chunk_data = base64.b64decode(chunk)
        if i == 0:
            combined = chunk_data
        else:
            data_pos = chunk_data.find(b"data")
            if data_pos != -1:
                combined += chunk_data[data_pos + 8 :]
    if len(resp.audios) > 1:
        total_size = len(combined) - 8
        combined = combined[:4] + total_size.to_bytes(4, "little") + combined[8:]
        data_pos = combined.find(b"data")
        if data_pos != -1:
            data_size = len(combined) - data_pos - 8
            combined = (
                combined[: data_pos + 4]
                + data_size.to_bytes(4, "little")
                + combined[data_pos + 8 :]
            )
    return combined


def resolve_speaker(speaker: str | None) -> str:
    s = (speaker or "shubh").strip().lower()
    if s in _V2_SPEAKERS or s not in _V3_SPEAKERS:
        raise ValueError(
            f"Invalid speaker '{speaker}'. Must be a bulbul:v3 speaker."
        )
    return s


def v3_speakers() -> list[str]:
    return sorted(_V3_SPEAKERS)


_TTS_CACHE_DIR = _CACHE_DIR / "tts"
_TTS_MEMORY: "OrderedDict[str, bytes]" = OrderedDict()
_TTS_MEMORY_MAX = 64
# One Bulbul request in flight per process — avoids 429 storms on Render.
_TTS_LOCK = threading.Lock()
_TTS_IN_FLIGHT = 0
_TTS_MAX_CHARS = 240
_LAZY_INTRO_WARM_STARTED = False
_LAZY_INTRO_WARM_LOCK = threading.Lock()


class TtsError(RuntimeError):
    """Structured TTS failure — never treat as empty success."""

    def __init__(self, message: str, *, status: object = None, language: str = ""):
        super().__init__(message)
        self.status = status
        self.language = language


def _tts_cache_key(text: str, lang: str, voice: str, pace: float) -> str:
    raw = f"{lang}|{voice}|{pace:.2f}|{text}".encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:32]


def _tts_cache_get(key: str) -> bytes | None:
    hit = _TTS_MEMORY.get(key)
    if hit is not None:
        _TTS_MEMORY.move_to_end(key)
        return hit
    path = _TTS_CACHE_DIR / f"{key}.wav"
    try:
        if path.is_file():
            data = path.read_bytes()
            _TTS_MEMORY[key] = data
            _TTS_MEMORY.move_to_end(key)
            while len(_TTS_MEMORY) > _TTS_MEMORY_MAX:
                _TTS_MEMORY.popitem(last=False)
            return data
    except OSError:
        logger.warning("[speak] cache read failed key=%s", key, exc_info=True)
    return None


def _tts_cache_put(key: str, data: bytes) -> None:
    _TTS_MEMORY[key] = data
    _TTS_MEMORY.move_to_end(key)
    while len(_TTS_MEMORY) > _TTS_MEMORY_MAX:
        _TTS_MEMORY.popitem(last=False)
    try:
        _TTS_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        (_TTS_CACHE_DIR / f"{key}.wav").write_bytes(data)
    except OSError:
        logger.warning("[speak] cache write failed key=%s", key, exc_info=True)


def _cap_tts_text(text: str, max_chars: int = _TTS_MAX_CHARS) -> str:
    trimmed = (text or "").strip()
    if not trimmed:
        return ""
    if len(trimmed) <= max_chars:
        return trimmed
    cut = trimmed[:max_chars].rsplit(" ", 1)[0].strip()
    return cut or trimmed[:max_chars].strip()


def _retry_after_seconds(exc: BaseException, default: float = 1.0) -> float:
    headers = getattr(exc, "headers", None) or {}
    raw = None
    try:
        items = headers.items() if hasattr(headers, "items") else []
        for key, value in items:
            if str(key).lower() == "retry-after":
                raw = value
                break
    except Exception:
        raw = None
    try:
        val = float(raw)
    except (TypeError, ValueError):
        val = default
    return max(0.0, min(val, 2.0))


def _is_http_429(exc: BaseException) -> bool:
    status = _error_status(exc)
    return status == 429 or str(status) == "429"


def _tts_provider_convert(
    *,
    text: str,
    lang: str,
    voice: str,
    pace: float,
):
    """One provider call with a single 429 retry honoring Retry-After (≤2s)."""
    client = get_client()

    def call():
        return client.text_to_speech.convert(
            text=text,
            target_language_code=lang,
            model="bulbul:v3",
            speaker=voice,
            pace=pace,
            # Do NOT pass pitch/loudness — v3 rejects those v2 params
        )

    try:
        return call()
    except BaseException as first:
        if not _is_http_429(first):
            raise
        wait_s = _retry_after_seconds(first, default=1.0)
        logger.info("[tts] retry_429 attempt=1 retry_after_s=%s", wait_s)
        time.sleep(wait_s)
        try:
            return call()
        except BaseException as second:
            logger.info(
                "[tts] failed status=%s language=%s",
                _error_status(second),
                lang,
            )
            raise TtsError(
                f"TTS rate-limited: {second}",
                status=_error_status(second),
                language=lang,
            ) from second


def _schedule_lazy_intro_warm(language: str) -> None:
    """After first real TTS success, optionally cache one te/hi/en intro — never at startup."""
    global _LAZY_INTRO_WARM_STARTED
    base = _lang_base(language)
    if base not in {"te", "hi", "en"}:
        return
    with _LAZY_INTRO_WARM_LOCK:
        if _LAZY_INTRO_WARM_STARTED:
            return
        _LAZY_INTRO_WARM_STARTED = True

    def _run() -> None:
        try:
            phrase = intro_for_language(base)
            speak(phrase, base)
            logger.info("[warmup] lazy_intro language=%s chars=%s", base, len(phrase))
        except Exception:
            logger.warning("[warmup] lazy_intro failed language=%s", base, exc_info=True)

    threading.Thread(target=_run, daemon=True, name="lazy-intro-tts").start()


def speak(
    text: str, language: str, speaker: str = "shubh", pace: float = 1.0
) -> bytes:
    global _TTS_IN_FLIGHT
    voice = resolve_speaker(speaker)
    lang = _lang_code(language)
    capped = _cap_tts_text(text, _TTS_MAX_CHARS)
    if not capped:
        raise TtsError("TTS text empty after cap", status="empty_text", language=lang)

    key = _tts_cache_key(capped, lang, voice, pace)
    cached = _tts_cache_get(key)
    if cached is not None:
        logger.info(
            "[tts] cache_hit=true language=%s chars=%s",
            lang,
            len(capped),
        )
        return cached

    wait_t0 = time.perf_counter()
    with _TTS_LOCK:
        wait_ms = int((time.perf_counter() - wait_t0) * 1000)
        logger.info("[tts] request_wait_ms=%s", wait_ms)
        _TTS_IN_FLIGHT += 1
        try:
            if _TTS_IN_FLIGHT != 1:
                # Should be impossible under a lock; keep for tests/observability.
                logger.warning("[tts] in_flight=%s under lock", _TTS_IN_FLIGHT)
            try:
                resp = _tts_provider_convert(
                    text=capped, lang=lang, voice=voice, pace=pace
                )
            except TtsError:
                raise
            except BaseException as exc:
                logger.info(
                    "[tts] failed status=%s language=%s",
                    _error_status(exc),
                    lang,
                )
                raise TtsError(
                    f"TTS failed: {exc}",
                    status=_error_status(exc),
                    language=lang,
                ) from exc
            audio = _tts_to_wav(resp)
            if not audio:
                logger.info("[tts] failed status=empty_audio language=%s", lang)
                raise TtsError(
                    "TTS returned empty audio",
                    status="empty_audio",
                    language=lang,
                )
            _tts_cache_put(key, audio)
        finally:
            _TTS_IN_FLIGHT -= 1

    _schedule_lazy_intro_warm(lang)
    return audio


def tts_in_flight_count() -> int:
    """Test helper: current in-flight Bulbul conversions (0 or 1)."""
    return _TTS_IN_FLIGHT


def listen(audio_bytes: bytes, filename: str, language: str | None = None) -> dict:
    client = get_client()

    def call():
        kwargs = {
            "file": (filename, io.BytesIO(audio_bytes)),
            "model": "saaras:v3",
            "mode": "codemix",
        }
        if language:
            kwargs["language_code"] = _lang_code(language)
        return client.speech_to_text.transcribe(
            **kwargs,
        )

    resp = _with_backoff(call)
    return {
        "transcript": resp.transcript,
        "language_code": resp.language_code or "",
    }


# One client for the process — constructing SarvamAI() per call costs ~2s TLS.
_client: SarvamAI | None = None


def get_client() -> SarvamAI:
    global _client
    if _client is None:
        key = (os.getenv("SARVAM_API_KEY") or "").strip()
        if not key:
            raise RuntimeError("SARVAM_API_KEY not set")
        _client = SarvamAI(api_subscription_key=key)
    return _client


def get_document(doc_id: str) -> dict | None:
    hit = _cache.get(doc_id)
    if hit:
        return hit
    try:
        import db as setu_db

        row = setu_db.get_document_text(doc_id)
        if row and row.get("ocr_text"):
            entry = {
                "text": row["ocr_text"],
                "pages": row.get("pages") or 1,
                "name": row.get("name"),
            }
            _cache[doc_id] = entry
            return entry
    except Exception:
        logger.warning("document db lookup failed for %s", doc_id, exc_info=True)
    return None


def load_ocr_cache() -> None:
    """Load disk cache into _cache. Missing/corrupt → empty, never raise."""
    try:
        if not _CACHE_FILE.exists():
            return
        data = json.loads(_CACHE_FILE.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            logger.warning("OCR cache root is not an object; starting empty")
            return
        loaded = 0
        for doc_id, entry in data.items():
            if isinstance(doc_id, str) and isinstance(entry, dict) and entry.get("text"):
                _cache[doc_id] = entry
                loaded += 1
        logger.info("Loaded OCR cache entries=%s from %s", loaded, _CACHE_FILE)
    except Exception:
        logger.warning("OCR cache load failed; starting empty", exc_info=True)


def _persist_ocr_cache() -> None:
    """Write-through: dump full _cache to disk. Failures are logged, not raised."""
    try:
        _CACHE_DIR.mkdir(parents=True, exist_ok=True)
        _CACHE_FILE.write_text(
            json.dumps(_cache, ensure_ascii=False),
            encoding="utf-8",
        )
    except Exception:
        logger.warning("OCR cache persist failed", exc_info=True)


def _set_cached_document(doc_id: str, entry: dict) -> None:
    _cache[doc_id] = entry
    _persist_ocr_cache()
    try:
        import db as setu_db

        setu_db.save_document(
            doc_id,
            entry.get("text") or "",
            pages=int(entry.get("pages") or 1),
            name=entry.get("name"),
        )
    except Exception:
        logger.warning("document db persist failed for %s", doc_id, exc_info=True)


def load_session_corrections() -> None:
    """Load session corrections from disk. Missing/corrupt → empty, never raise."""
    global _session_corrections
    try:
        if not _CORRECTIONS_FILE.exists():
            return
        data = json.loads(_CORRECTIONS_FILE.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            logger.warning("Corrections root is not an object; starting empty")
            return
        loaded_sessions = 0
        for session_id, fields in data.items():
            if not isinstance(session_id, str) or not isinstance(fields, dict):
                continue
            clean: dict[str, dict] = {}
            for field, item in fields.items():
                if not isinstance(field, str) or not isinstance(item, dict):
                    continue
                value = item.get("value")
                if not isinstance(value, str) or not value.strip():
                    continue
                clean[field] = {
                    "field": field,
                    "value": value.strip(),
                    "timestamp": item.get("timestamp") or time.time(),
                }
            if clean:
                _session_corrections[session_id] = clean
                loaded_sessions += 1
        logger.info(
            "Loaded session corrections sessions=%s from %s",
            loaded_sessions,
            _CORRECTIONS_FILE,
        )
    except Exception:
        logger.warning("Session corrections load failed; starting empty", exc_info=True)
        _session_corrections = {}


def _persist_session_corrections() -> None:
    try:
        _CACHE_DIR.mkdir(parents=True, exist_ok=True)
        _CORRECTIONS_FILE.write_text(
            json.dumps(_session_corrections, ensure_ascii=False),
            encoding="utf-8",
        )
    except Exception:
        logger.warning("Session corrections persist failed", exc_info=True)


def get_session_corrections(session_id: str) -> list[dict]:
    """Active corrections for a session as a list (one entry per field)."""
    by_field = _session_corrections.get(session_id) or {}
    return sorted(by_field.values(), key=lambda item: item.get("timestamp") or 0)


def _slug_field(raw: str) -> str:
    s = re.sub(r"\s+", "_", (raw or "").strip().lower())
    s = re.sub(r"[^\w]+", "", s)
    return (s[:64] or "note")


def extract_corrections(utterance: str) -> list[dict]:
    """Detect user-stated self-corrections. Returns [{field, value}] (no timestamp)."""
    text = (utterance or "").strip()
    if not text:
        return []

    # "my land is 2 acres not 3"
    m = re.search(
        r"\bmy\s+([a-zA-Z][\w\s/-]{0,40}?)\s+is\s+(.+?)\s*,?\s*not\b",
        text,
        re.I,
    )
    if m:
        return [{"field": _slug_field(m.group(1)), "value": m.group(2).strip(" .,;:")}]

    # "I'm in Warangal district not Karimnagar" / "I am in …"
    m = re.search(
        r"\bi(?:'m|\s+am)\s+in\s+(.+?)\s*,?\s*not\b",
        text,
        re.I,
    )
    if m:
        value = m.group(1).strip(" .,;:")
        field = "district" if re.search(r"\bdistrict\b", value, re.I) else "location"
        return [{"field": field, "value": value}]

    # "actually[,]? my land is 2 acres" / "correction: district is Warangal"
    m = re.search(
        r"\b(?:actually|correction|rather)[,:]?\s*(?:my\s+)?"
        r"([a-zA-Z][\w\s/-]{0,40}?)\s+is\s+(.+)$",
        text,
        re.I,
    )
    if m:
        value = m.group(2).strip(" .,;:")
        # Drop trailing "not …" if present
        value = re.split(r"\s+not\b", value, maxsplit=1, flags=re.I)[0].strip(" .,;:")
        if value:
            return [{"field": _slug_field(m.group(1)), "value": value}]

    return []


def upsert_corrections(session_id: str, items: list[dict]) -> list[dict]:
    """Store corrections; same field supersedes. Returns active list."""
    if not session_id or not items:
        return get_session_corrections(session_id)
    bucket = _session_corrections.setdefault(session_id, {})
    now = time.time()
    for item in items:
        field = _slug_field(str(item.get("field") or ""))
        value = str(item.get("value") or "").strip()
        if not field or not value:
            continue
        bucket[field] = {"field": field, "value": value, "timestamp": now}
    _persist_session_corrections()
    return get_session_corrections(session_id)


def ingest_corrections_from_utterance(session_id: str, utterance: str) -> list[dict]:
    """Detect + persist corrections from an /ask utterance; return active list."""
    if not session_id:
        return []
    extracted = extract_corrections(utterance)
    if extracted:
        return upsert_corrections(session_id, extracted)
    return get_session_corrections(session_id)


def _normalize_text(text: str) -> str:
    # Strip ALL whitespace — Vision mid-word newlines vs model rejoining
    # without spaces (quote "ab" must match doc "a\nb").
    text = re.sub(r"\s+", "", text)
    # Vision markdown also injects list markers mid-sentence ("\n7. ", "\n8. ").
    text = re.sub(r"\d+\.", "", text)
    return text


def verify_citations(evidence: list, doc_text: str) -> list:
    """Per-evidence `verified` via string match on cached OCR text (not an LLM).

    Normalizes quote + doc (strip all whitespace, strip ``\\d+.`` markers), then
    checks whether the normalized quote is a substring of the normalized OCR.
    Empty quotes are unverified.
    """
    norm_doc = _normalize_text(doc_text)
    out = []
    for item in evidence:
        quote = item.get("quote", "")
        verified = bool(quote) and _normalize_text(quote) in norm_doc
        out.append({**item, "verified": bool(verified)})
    return out


def is_converse_allowed(message: str) -> bool:
    """True only for greetings / thanks / Setu-meta. Bias: redirect otherwise."""
    text = (message or "").strip()
    if not text:
        return False
    if _DOC_QUESTION_RE.search(text) or _NEEDS_DOC_RE.search(text):
        return False
    return bool(_CONVERSE_ALLOW_RE.search(text))


def _parse_answer_json(content: str) -> dict:
    text = (content or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)

    def _try_load(raw: str) -> dict | None:
        try:
            data = json.loads(raw)
            return data if isinstance(data, dict) else None
        except json.JSONDecodeError:
            return None

    parsed = _try_load(text)
    if parsed is not None:
        return parsed

    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end > start:
        parsed = _try_load(text[start : end + 1])
        if parsed is not None:
            return parsed

    # Truncated structured output — salvage fields we can still read.
    answer_m = re.search(r'"answer"\s*:\s*"((?:\\.|[^"\\])*)"', text)
    if answer_m:
        try:
            answer = json.loads(f'"{answer_m.group(1)}"')
        except json.JSONDecodeError:
            answer = answer_m.group(1)
        status_m = re.search(r'"status"\s*:\s*"(\w+)"', text)
        lang_m = re.search(r'"language"\s*:\s*"([^"]+)"', text)
        abstain = '"status":"not_found"' in text.replace(" ", "") or (
            status_m is not None and status_m.group(1) == "not_found"
        )
        return {
            "answer": answer,
            "language": lang_m.group(1) if lang_m else "en",
            "status": status_m.group(1) if status_m else ("not_found" if abstain else "verified_document"),
            "action_items": [],
            "evidence": [],
            "abstain": abstain,
        }

    abstain = '"status": "not_found"' in text.replace(" ", "")
    if text.endswith("]") and '"abstain"' not in text:
        repaired = text + f', "abstain": {str(abstain).lower()}}}'
        parsed = _try_load(repaired)
        if parsed is not None:
            return parsed

    raise json.JSONDecodeError("Could not parse answer JSON", text, 0)


def cap_answer_sentences(text: str, n: int = 2) -> str:
    """Hard-cap spoken answer length — TTS grows badly with long paragraphs."""
    text = (text or "").strip()
    if not text:
        return text
    parts = re.split(r"(?<=[.!?।॥])\s+", text)
    parts = [p for p in parts if p]
    if len(parts) <= n:
        return text
    return " ".join(parts[:n])


def _chat_intent(message: str, has_document: bool) -> str:
    if not has_document and _NEEDS_DOC_RE.search(message):
        return "needs_document"
    if _DOC_QUESTION_RE.search(message):
        return "document_question"
    return "chat"


def _language_name(language: str) -> str:
    code = (language or "en").strip().lower().split("-", 1)[0]
    name = _LANG_NAMES.get(code)
    if not name:
        logger.warning(
            "[lang] unknown language code=%r — falling back to English name",
            language,
        )
        return _LANG_NAMES["en"]
    return name


def _lang_base(language: str | None) -> str:
    return (language or "").strip().lower().split("-", 1)[0]


def _is_mostly_latin(text: str) -> bool:
    """True when alphabetic characters are mostly Latin (ASCII) script.

    Used to detect Sarvam answering in English when an Indic language was
    requested — call sites in chat_reply retry once for native script.
    """
    letters = [c for c in (text or "") if c.isalpha()]
    if not letters:
        return True
    latin = sum(1 for c in letters if ord(c) < 128)
    return latin / len(letters) > 0.55


def _history_language(history: list[dict] | None) -> str | None:
    """Language of the most recent turn that carries a language tag."""
    if not history:
        return None
    for item in reversed(history):
        code = _lang_base(item.get("language") if isinstance(item, dict) else None)
        if code:
            return code
    return None


def _cap_chat_history(
    history: list[dict] | None,
    *,
    requested_language: str | None = None,
    max_turns: int = 12,
    max_chars: int = 6000,
) -> list[dict]:
    """Normalize and trim prior turns while retaining context across languages."""
    if not history:
        return []
    out: list[dict] = []
    for item in history[-max_turns:]:
        role = (item.get("role") or "").strip().lower()
        content = (item.get("content") or "").strip()
        if not content:
            continue
        if role in ("setu", "assistant", "model"):
            role = "assistant"
        elif role != "user":
            continue
        out.append({"role": role, "content": content})
    while out and sum(len(m["content"]) for m in out) > max_chars:
        out = out[1:]
    if out and sum(len(m["content"]) for m in out) > max_chars:
        budget = max_chars - sum(len(m["content"]) for m in out[1:])
        out[0] = {**out[0], "content": out[0]["content"][-max(0, budget) :]}
    return out


def _log_messages(route: str, messages: list[dict]) -> None:
    try:
        payload = json.dumps(messages, ensure_ascii=False)
    except TypeError:
        payload = str(messages)
    logger.info("[messages] %s %s", route, payload)


SETU_INTRO_EN = (
    "Hi. I am Setu. Ask me anything, or show me a document and I will explain it."
)

# After language pick — short onboarding intro in that language (< ~25 words).
SETU_INTRO_BY_LANG: dict[str, str] = {
    "en": SETU_INTRO_EN,
    "te": "నమస్కారం. నేను సేతు. ఏదైనా అడగండి, లేదా పత్రం చూపిస్తే వివరిస్తాను.",
    "hi": "नमस्ते. मैं सेतु हूँ. कुछ भी पूछें, या दस्तावेज़ दिखाएँ — मैं समझाऊँगा.",
    "mr": "नमस्कार. मी सेतू. काहीही विचारा, किंवा कागद दाखवा — मी समजावीन.",
    "ta": "வணக்கம். நான் சேது. எதையும் கேளுங்கள், அல்லது ஆவணம் காட்டுங்கள்.",
    "kn": "ನಮಸ್ಕಾರ. ನಾನು ಸೇತು. ಏನಾದರೂ ಕೇಳಿ, ಅಥವಾ ದಾಖಲೆ ತೋರಿಸಿ.",
    "bn": "নমস্কার. আমি সেতু. যেকোনো প্রশ্ন করুন, বা নথি দেখান.",
    "gu": "નમસ્તે. હું સેતુ. કંઈ પણ પૂછો, અથવા દસ્તાવેજ બતાવો.",
    "ml": "നമസ്കാരം. ഞാൻ സേതു. എന്തും ചോദിക്കൂ, അല്ലെങ്കിൽ രേഖ കാണിക്കൂ.",
    "pa": "ਸਤ ਸ੍ਰੀ ਅਕਾਲ. ਮੈਂ ਸੇਤੂ ਹਾਂ. ਕੁਝ ਵੀ ਪੁੱਛੋ, ਜਾਂ ਦਸਤਾਵੇਜ਼ ਵਿਖਾਓ.",
    "or": "ନମସ୍କାର. ମୁଁ ସେତୁ. କିଛି ପଚାରନ୍ତୁ, କିମ୍ବା ଦଲିଲ ଦେଖାନ୍ତୁ.",
}

def intro_for_language(language: str) -> str:
    """Warm spoken intro after the user picks a language."""
    base = _lang_base(language) or "en"
    return SETU_INTRO_BY_LANG.get(base, SETU_INTRO_EN)


VOICE_LANGUAGE_PROMPT = (
    "Hi, welcome to Setu. I need the microphone to hear you, and the camera only "
    "when you show a document. Which language do you prefer?"
)

BRIEF_ACK_BY_LANG: dict[str, str] = {
    "te": "సరే.",
    "hi": "ठीक है.",
    "en": "Okay.",
    "mr": "ठीक आहे.",
    "ta": "சரி.",
    "kn": "ಸರಿ.",
    "bn": "ঠিক আছে.",
    "gu": "બરાબર.",
    "ml": "ശരി.",
    "pa": "ਠੀਕ ਹੈ.",
    "or": "ଠିକ୍ ଅଛି.",
}

LANGUAGE_SWITCH_BY_LANG: dict[str, str] = {
    "te": "అవును.",
    "hi": "हाँ.",
    "en": "Yes.",
    "mr": "होय.",
    "ta": "ஆம்.",
    "kn": "ಹೌದು.",
    "bn": "হ্যাঁ.",
    "gu": "હા.",
    "ml": "അതെ.",
    "pa": "ਹਾਂ.",
    "or": "ହଁ.",
}

CAMERA_PHRASES_BY_LANG: dict[str, dict[str, str]] = {
    "en": {
        "show": "Please hold your document up to the camera so I can read it.",
        "upload": "Camera is unavailable. Please upload a photo of the document instead.",
        "ready": "Ready.",
        "unclear": "Could not read that clearly",
        "reading": "Reading",
    },
    "te": {
        "show": "దయచేసి పత్రాన్ని కెమెరా ముందు చూపించండి, నేను చదువుతాను.",
        "upload": "కెమెరా లేదు. దయచేసి పత్రం ఫోటో అప్‌లోడ్ చేయండి.",
        "ready": "సరే.",
        "unclear": "స్పష్టంగా చదవలేకపోయాను",
        "reading": "చదువుతున్నాను",
    },
    "hi": {
        "show": "कृपया दस्तावेज़ कैमरे के सामने दिखाइए, मैं पढ़ूँगा.",
        "upload": "कैमरा उपलब्ध नहीं है. कृपया दस्तावेज़ की फ़ोटो अपलोड करें.",
        "ready": "हाँ.",
        "unclear": "साफ़ नहीं पढ़ सका",
        "reading": "पढ़ रहा हूँ",
    },
    "mr": {
        "show": "कृपया कागद कॅमेऱ्यासमोर दाखवा, मी वाचेन.",
        "upload": "कॅमेरा उपलब्ध नाही. कृपया कागदाचा फोटो अपलोड करा.",
        "ready": "होय.",
        "unclear": "स्पष्ट वाचता आले नाही",
        "reading": "वाचत आहे",
    },
    "ta": {
        "show": "தயவுசெய்து ஆவணத்தை கேமராவுக்குக் காட்டுங்கள், நான் படிப்பேன்.",
        "upload": "கேமரா இல்லை. ஆவணப் படத்தைப் பதிவேற்றுங்கள்.",
        "ready": "ஆம்.",
        "unclear": "தெளிவாகப் படிக்க முடியவில்லை",
        "reading": "படிக்கிறேன்",
    },
    "kn": {
        "show": "ದಯವಿಟ್ಟು ದಾಖಲೆಯನ್ನು ಕ್ಯಾಮೆರಾಗೆ ತೋರಿಸಿ, ನಾನು ಓದುತ್ತೇನೆ.",
        "upload": "ಕ್ಯಾಮೆರಾ ಇಲ್ಲ. ದಾಖಲೆಯ ಫೋಟೋ ಅಪ್‌ಲೋಡ್ ಮಾಡಿ.",
        "ready": "ಹೌದು.",
        "unclear": "ಸ್ಪಷ್ಟವಾಗಿ ಓದಲಾಗಲಿಲ್ಲ",
        "reading": "ಓದುತ್ತಿದ್ದೇನೆ",
    },
}

AGENT_ERROR_BY_LANG: dict[str, str] = {
    "en": "Sorry, something went wrong — please try again.",
    "te": "క్షమించండి, ఏదో తప్పు జరిగింది — మళ్లీ ప్రయత్నించండి.",
    "hi": "माफ़ कीजिए, कुछ गलत हो गया — कृपया फिर कोशिश करें.",
    "mr": "माफ करा, काहीतरी चुकले — पुन्हा प्रयत्न करा.",
    "ta": "மன்னிக்கவும், ஏதோ தவறு நடந்தது — மீண்டும் முயற்சிக்கவும்.",
    "kn": "ಕ್ಷಮಿಸಿ, ಏನೋ ತಪ್ಪಾಗಿದೆ — ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.",
    "bn": "দুঃখিত, কিছু ভুল হয়েছে — আবার চেষ্টা করুন।",
    "gu": "માફ કરો, કંઈક ખોટું થયું — ફરી પ્રયાસ કરો.",
    "ml": "ക്ഷമിക്കണം, എന്തോ തെറ്റായി — വീണ്ടും ശ്രമിക്കൂ.",
    "pa": "ਮਾਫ਼ ਕਰੋ, ਕੁਝ ਗਲਤ ਹੋ ਗਿਆ — ਮੁੜ ਕੋਸ਼ਿਸ਼ ਕਰੋ।",
    "or": "କ୍ଷମା କରନ୍ତୁ, କିଛି ଭୁଲ ହେଲା — ପୁଣି ଚେଷ୍ଟା କରନ୍ତୁ।",
}


def brief_ack_for_language(language: str) -> str:
    base = _lang_base(language) or "en"
    return BRIEF_ACK_BY_LANG.get(base, BRIEF_ACK_BY_LANG["en"])


def agent_error_phrase_for_language(language: str) -> str:
    """Short spoken fallback when the agent raises mid-turn."""
    base = _lang_base(language) or "en"
    return AGENT_ERROR_BY_LANG.get(base, AGENT_ERROR_BY_LANG["en"])


def language_switch_for_language(language: str) -> str:
    base = _lang_base(language) or "en"
    return LANGUAGE_SWITCH_BY_LANG.get(base, LANGUAGE_SWITCH_BY_LANG["en"])


def camera_phrase(language: str, key: str) -> str:
    base = _lang_base(language) or "en"
    phrases = CAMERA_PHRASES_BY_LANG.get(base) or CAMERA_PHRASES_BY_LANG["en"]
    return phrases.get(key) or CAMERA_PHRASES_BY_LANG["en"].get(key, "")


def spoken_text(text: str, max_chars: int = 240) -> str:
    """Spoken truncation for TTS — one short sentence, hard-capped."""
    trimmed = (text or "").strip()
    if not trimmed:
        return ""
    capped = cap_answer_sentences(trimmed, 1)
    if len(capped) <= max_chars:
        return capped
    cut = capped[:max_chars].rsplit(" ", 1)[0].strip()
    return cut or capped[:max_chars].strip()


def fixed_warm_phrases() -> list[tuple[str, str]]:
    """Deprecated: startup must not bulk-warm TTS. Kept for tests/compat (empty)."""
    return []


def chat_reply(
    message: str,
    language: str,
    has_document: bool,
    history: list[dict] | None = None,
    memory_context: str | None = None,
) -> dict:
    """Fast path: sarvam-105b, no document, no JSON schema. Target <1.5s."""
    language_name = _language_name(language)
    if has_document:
        doc_rule = (
            "A document is already loaded. NEVER ask the user to paste, upload, "
            "show, or scan a document."
        )
    elif memory_context:
        # Without this, "what document did I show you?" hits the camera prompt and
        # contradicts the memory Setu was just given.
        doc_rule = (
            "No document is loaded right now. Questions about a document you read in an "
            "earlier chat must be answered from MEMORY. Only ask the user to show a "
            "document to the camera when they want you to read a new one — never say paste."
        )
    else:
        doc_rule = (
            "No document is loaded. If the user asks about a document, ask them "
            "to show it to the camera — never say paste."
        )
    system = (
        f"CRITICAL: Your entire reply must be in {language_name} script only. "
        f"The user may write in any language or script — ignore that completely "
        f"and always answer in {language_name}. "
        f"You are Setu, a capable voice agent for Indian languages. "
        f"You can chat, remember earlier chats, help with documents via camera, "
        f"and answer follow-ups naturally. {doc_rule} "
        "Use prior conversation turns for follow-ups. A language switch is not a new "
        "conversation: never greet the user again or restart the introduction after one. "
        "Reply in ONE or TWO short sentences. "
        f"CRITICAL: Your entire reply must be in {language_name} script only."
    )
    history_msgs = _cap_chat_history(history, requested_language=language)
    lang_after = (
        f"CRITICAL LANGUAGE OVERRIDE: Ignore the language of any earlier turns. "
        f"Your entire next reply must be in {language_name} only "
        f"(native script for {language_name})."
    )
    doc_state = (
        "has_document=true"
        if has_document
        else "has_document=false (nothing in the camera now; earlier documents are in MEMORY)"
        if memory_context
        else "has_document=false"
    )
    user_content = (
        f"{doc_state}\n"
        f"User: {message}\n"
        f"(Reply in {language_name}.)"
    )
    # Memory sits next to the user turn rather than inside the long opening prompt:
    # buried in the middle it got ignored and Setu claimed it had no record.
    memory_msgs = (
        [{
            "role": "system",
            "content": (
                "MEMORY — real transcripts of this user's earlier chats with you. "
                "These happened; treat them as your own recollection.\n"
                f"{memory_context}\n"
                "Whenever the user asks what you discussed, what you were doing, which "
                "document they showed you, or anything else about the past, answer from "
                "MEMORY and state the specific detail. A document named in MEMORY WAS "
                "shown to you, so never reply that they have not shown you a document. "
                "You are NEVER allowed to say you have no record, no access, or cannot "
                "remember while MEMORY is present, and never ask the user to remind you."
            ),
        }]
        if memory_context
        else []
    )
    messages = [
        {"role": "system", "content": system},
        *history_msgs,
        {"role": "system", "content": lang_after},
        *memory_msgs,
        {"role": "user", "content": user_content},
    ]
    _log_messages("/converse", messages)

    def call():
        return get_client().chat.completions(
            model="sarvam-105b",
            messages=messages,
            reasoning_effort=None,  # required — thinking + low max_tokens → empty content
            max_tokens=140,
            temperature=0.2,
        )

    resp = _with_backoff(call)
    content = (resp.choices[0].message.content or "").strip()
    if not content:
        raise RuntimeError("Empty model response")
    # Sarvam sometimes replies in English even when Telugu/Hindi was requested — retry once.
    if _lang_base(language) != "en" and _is_mostly_latin(content):
        retry_messages = [
            *messages,
            {"role": "assistant", "content": content},
            {
                "role": "user",
                "content": (
                    f"Wrong language. Rewrite ONLY in {language_name} native script. "
                    f"No English words at all."
                ),
            },
        ]
        retry = _with_backoff(
            lambda: get_client().chat.completions(
                model="sarvam-105b",
                messages=retry_messages,
                reasoning_effort=None,
                max_tokens=60,
                temperature=0.1,
            )
        )
        retry_content = (retry.choices[0].message.content or "").strip()
        if retry_content and not _is_mostly_latin(retry_content):
            content = retry_content
    return {
        "reply": content,
        "intent": _chat_intent(message, has_document),
    }


def _is_short_factual_question(question: str) -> bool:
    """Fast /ask path: prefer 30b for most lookups; 105b only for long/open explainers."""
    text = (question or "").strip()
    if not text:
        return False
    words = text.split()
    # Long multi-part questions stay on 105b.
    if len(words) > 28:
        return False
    if re.search(
        r"\b(explain in detail|summarize|summary|overview|describe in detail|"
        r"tell me everything|what does (this|the) (document|notice|paper) say|"
        r"what is this (document|notice|paper) about|explain this document|"
        r"what's in (this|the) document|"
        r"అదే దాని గురించ|पूरी तरह बताओ|विस्तार से वर्णन)\b",
        text,
        re.I,
    ):
        return False
    # Deadlines, fees, eligibility, dates, amounts → always fast.
    if re.search(
        r"\b(deadline|last date|due date|fee|fees|amount|eligible|eligibility|"
        r"when|where|how much|how many|who|which|required|documents? needed|"
        r"तारीख|राशि|पात्र|शुल्क|యోగ్య|తేదీ|ఎంత|கட்டணம்|ಕಡ್ಡಾಯ)\b",
        text,
        re.I,
    ):
        return True
    if _DOC_QUESTION_RE.search(text):
        return True
    return len(words) <= 18


def ask_document(
    doc_text: str,
    question: str,
    answer_language: str,
    history: list[dict] | None = None,
    corrections: list[dict] | None = None,
) -> dict:
    client = get_client()
    # Cap context — full docs on every /ask burn tokens and invite 429s.
    clipped = (doc_text or "")[:6000]
    lang_name = _language_name(answer_language)
    history_msgs = _cap_chat_history(history, requested_language=answer_language)
    lang_after = (
        f"CRITICAL LANGUAGE OVERRIDE: Ignore the language of any earlier turns. "
        f"The answer field MUST be in {lang_name} only "
        f"(native script). language field = \"{_lang_base(answer_language) or 'en'}\"."
    )
    corr_block = ""
    if corrections:
        lines = [
            f"- {item.get('field')}: {item.get('value')}"
            for item in corrections
            if item.get("field") and item.get("value")
        ]
        if lines:
            corr_block = (
                "User-stated corrections about themselves "
                "(NOT from the document — never cite as evidence):\n"
                + "\n".join(lines)
                + "\n\n"
            )
    user_content = (
        f"Answer language (mandatory): {answer_language} — write the answer in {lang_name} only.\n\n"
        f"Document text:\n\n{clipped}\n\n"
        f"{corr_block}"
        f"Question: {question}\n"
        f"Answer language code: {answer_language}\n"
        f"(Reply in {lang_name}.)"
    )
    messages = [
        {"role": "system", "content": _ask_system_prompt(answer_language)},
        *history_msgs,
        {"role": "system", "content": lang_after},
        {"role": "user", "content": user_content},
    ]
    _log_messages("/ask", messages)
    stats = {"attempts": 0, "call_ms": 0}
    t_total = time.perf_counter()
    use_fast = _is_short_factual_question(question)
    model = "sarvam-105b"
    max_tokens = 768 if use_fast else 1536

    def call():
        stats["attempts"] += 1
        t0 = time.perf_counter()
        try:
            return client.chat.completions(
                model=model,
                messages=messages,
                reasoning_effort=None,
                max_tokens=max_tokens,
                request_options={
                    "additional_body_parameters": {
                        "response_format": {
                            "type": "json_schema",
                            "json_schema": _ANSWER_SCHEMA,
                        }
                    }
                },
            )
        finally:
            stats["call_ms"] += int((time.perf_counter() - t0) * 1000)

    try:
        resp = _with_backoff(call)
    finally:
        total_ms = int((time.perf_counter() - t_total) * 1000)
        print(
            f"[ask] model={model} sarvam_call={stats['call_ms']}ms "
            f"attempts={stats['attempts']} total={total_ms}ms"
        )
    content = resp.choices[0].message.content
    if not content:
        raise RuntimeError("Empty model response")
    result = _parse_answer_json(content)
    result["answer"] = cap_answer_sentences(result.get("answer", ""), 2)
    result["model_used"] = model
    return result


def summarize_document(doc_text: str, answer_language: str) -> str:
    """Fast post-scan overview — sarvam-105b, 2–3 sentences, no verification schema."""
    client = get_client()
    clipped = (doc_text or "")[:6000]
    lang_name = _language_name(answer_language)
    messages = [
        {
            "role": "system",
            "content": (
                f"You briefly describe scanned text for a voice assistant. "
                f"Reply in {lang_name} only (native script). "
                "Write exactly ONE short sentence. Do not call it a government document unless the text says so. No bullet points."
            ),
        },
        {
            "role": "user",
            "content": f"Summarize this document in 2–3 sentences:\n\n{clipped}",
        },
    ]
    stats = {"attempts": 0, "call_ms": 0}
    t_total = time.perf_counter()

    def call():
        stats["attempts"] += 1
        t0 = time.perf_counter()
        try:
            return client.chat.completions(
                model="sarvam-105b",
                messages=messages,
                reasoning_effort=None,
                max_tokens=400,
                temperature=0.2,
            )
        finally:
            stats["call_ms"] += int((time.perf_counter() - t0) * 1000)

    resp = _with_backoff(call)
    total_ms = int((time.perf_counter() - t_total) * 1000)
    print(
        f"[summarize] model=sarvam-105b sarvam_call={stats['call_ms']}ms "
        f"attempts={stats['attempts']} total={total_ms}ms"
    )
    content = (resp.choices[0].message.content or "").strip()
    if not content:
        raise RuntimeError("Empty summarize response")
    return cap_answer_sentences(content, 3)


def _detect_format(data: bytes) -> str | None:
    if data.startswith(b"%PDF"):
        return "pdf"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    return None


def _correct_filename(filename: str, actual: str) -> str:
    stem = Path(filename).stem or "document"
    return f"{stem}{_FORMAT_EXT[actual]}"


def _retryable(exc: BaseException) -> bool:
    """Retry rate limits and transient network / DNS failures."""
    if isinstance(exc, ApiError):
        return exc.status_code in (429, 503)
    if isinstance(exc, httpx.HTTPStatusError):
        return exc.response.status_code in (429, 503)
    if isinstance(
        exc,
        (
            httpx.ConnectError,
            httpx.ConnectTimeout,
            httpx.ReadTimeout,
            httpx.RemoteProtocolError,
            httpx.NetworkError,
            TimeoutError,
            ConnectionError,
            OSError,
        ),
    ):
        # Includes socket.gaierror / Errno 8 "nodename nor servname…"
        return True
    # Some SDKs wrap DNS failures in generic Exception strings.
    msg = str(exc).lower()
    if "nodename nor servname" in msg or "name or service not known" in msg:
        return True
    if "failed to resolve" in msg or "name resolution" in msg:
        return True
    return False


def _error_status(exc: BaseException) -> object:
    if isinstance(exc, ApiError):
        return exc.status_code
    if isinstance(exc, httpx.HTTPStatusError):
        return exc.response.status_code
    return type(exc).__name__


def _with_backoff(fn, *, max_retries: int = 4):
    delay = 0.6
    last: BaseException | None = None
    for attempt in range(max_retries):
        try:
            return fn()
        except BaseException as exc:
            last = exc
            status = _error_status(exc)
            print(f"[retry] attempt={attempt + 1} status={status} error={exc}")
            if not _retryable(exc) or attempt == max_retries - 1:
                raise
            time.sleep(delay)
            delay = min(delay * 2, 6.0)
    raise last  # ponytail: unreachable unless max_retries==0


def _friendly_vision_error(exc: BaseException) -> str:
    msg = str(exc)
    lower = msg.lower()
    if (
        "nodename nor servname" in lower
        or "name or service not known" in lower
        or "failed to resolve" in lower
        or isinstance(exc, (httpx.ConnectError, httpx.ConnectTimeout, OSError))
    ):
        return (
            "Could not reach the document reader (network/DNS). "
            "Check your connection and try again."
        )
    return f"Vision failed: {exc}"


_VISION_MAX_PAGES = 10
# Vision rate limit ≈ 10 req/min — wait between sequential chunk jobs when budget allows.
_VISION_CHUNK_GAP_S = 6.5

OCR_TIMEOUT_DETAIL = (
    "Document analysis is taking too long. Please retry with a clearer photo."
)
_OCR_POLL_SCHEDULE = (0.5, 1.0, 1.5)
_OCR_POLL_MAX_S = 2.0
_VISION_TERMINAL = frozenset({"Completed", "PartiallyCompleted", "Failed"})


def ocr_timeout_seconds() -> float:
    """Hard total OCR/Vision budget. OCR_TIMEOUT_SECONDS wins; legacy VISION_JOB_TIMEOUT_S ok."""
    raw = (os.getenv("OCR_TIMEOUT_SECONDS") or "").strip()
    if not raw:
        raw = (os.getenv("VISION_JOB_TIMEOUT_S") or "15").strip()
    try:
        return max(1.0, float(raw))
    except ValueError:
        return 15.0


def _poll_sleep_seconds(sleep_index: int) -> float:
    if sleep_index < len(_OCR_POLL_SCHEDULE):
        return _OCR_POLL_SCHEDULE[sleep_index]
    return _OCR_POLL_MAX_S


def _pdf_page_count(file_bytes: bytes) -> int:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(file_bytes))
    return len(reader.pages)


def _pdf_slice(file_bytes: bytes, start: int, end: int) -> bytes:
    from pypdf import PdfReader, PdfWriter

    reader = PdfReader(io.BytesIO(file_bytes))
    writer = PdfWriter()
    for index in range(start, end):
        writer.add_page(reader.pages[index])
    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue()


def _job_id_of(job) -> str:
    return str(getattr(job, "_job_id", None) or getattr(job, "job_id", None) or "?")


def _download_vision_text(job) -> tuple[str, int]:
    out_fd, out_path = tempfile.mkstemp(suffix=".md")
    os.close(out_fd)
    try:
        _with_backoff(lambda: job.download_output(out_path))
        raw = Path(out_path).read_bytes()
        if raw[:2] == b"PK":
            with zipfile.ZipFile(io.BytesIO(raw)) as zf:
                md = next(n for n in zf.namelist() if n.endswith(".md"))
                text = zf.read(md).decode("utf-8")
        else:
            text = raw.decode("utf-8")
    finally:
        os.unlink(out_path)

    metrics = job.get_page_metrics()
    pages = int(metrics["total_pages"]) if metrics and metrics.get("total_pages") else 1
    return text, pages


def _run_vision(
    file_bytes: bytes,
    filename: str,
    language: str = "te-IN",
    *,
    progress=None,
    deadline: float | None = None,
) -> dict:
    """Run one Sarvam Document Intelligence job with bounded status polling.

    Returns structured dict with status in {done, timeout, error}.
    Never calls wait_until_complete (SDK default polls forever every 2s).
    """
    actual = _detect_format(file_bytes)
    if actual not in _FORMAT_EXT:
        raise ValueError("Unsupported file format; accepts PDF, PNG, JPG")

    upload_name = _correct_filename(filename, actual)
    client = get_client()
    lang = language or "te-IN"
    timeout_s = ocr_timeout_seconds()
    if deadline is None:
        deadline = time.perf_counter() + timeout_s

    def create_job():
        return client.document_intelligence.create_job(language=lang, output_format="md")

    job = _with_backoff(create_job)
    job_id = _job_id_of(job)
    polls = 0

    with tempfile.NamedTemporaryFile(suffix=Path(upload_name).suffix, delete=False) as tmp:
        tmp.write(file_bytes)
        tmp_path = tmp.name

    try:
        if time.perf_counter() >= deadline:
            return {
                "status": "timeout",
                "detail": OCR_TIMEOUT_DETAIL,
                "job_id": job_id,
                "polls": polls,
                "pages": 0,
                "text": "",
            }

        _with_backoff(lambda: job.upload_file(tmp_path))
        _with_backoff(job.start)
        _emit(
            progress,
            {
                "type": "progress",
                "stage": "ocr_started",
                "percent": 20,
                "message": "Reading document",
            },
        )
        logger.debug("[ocr] vision job_id=%s started", job_id)

        sleep_index = 0
        status = None
        while True:
            remaining = deadline - time.perf_counter()
            if remaining <= 0:
                logger.debug(
                    "[ocr] vision job_id=%s timeout after polls=%s",
                    job_id,
                    polls,
                )
                return {
                    "status": "timeout",
                    "detail": OCR_TIMEOUT_DETAIL,
                    "job_id": job_id,
                    "polls": polls,
                    "pages": 0,
                    "text": "",
                }

            status = job.get_status()
            polls += 1
            state = getattr(status, "job_state", None)
            logger.debug(
                "[ocr] vision job_id=%s state=%s poll=%s",
                job_id,
                state,
                polls,
            )

            if state in _VISION_TERMINAL:
                break

            _emit(
                progress,
                {
                    "type": "progress",
                    "stage": "ocr_polling",
                    "percent": min(85, 40 + polls * 5),
                    "message": "Reading document",
                },
            )

            delay = _poll_sleep_seconds(sleep_index)
            sleep_index += 1
            remaining = deadline - time.perf_counter()
            if remaining <= 0:
                return {
                    "status": "timeout",
                    "detail": OCR_TIMEOUT_DETAIL,
                    "job_id": job_id,
                    "polls": polls,
                    "pages": 0,
                    "text": "",
                }
            time.sleep(min(delay, remaining))

        if status is None or status.job_state == "Failed":
            detail = "Document analysis failed. Please retry with a clearer photo."
            err = getattr(status, "error_message", None) or getattr(status, "message", None)
            if isinstance(err, str) and err.strip() and "key" not in err.lower():
                detail = err.strip()[:240]
            return {
                "status": "error",
                "detail": detail,
                "job_id": job_id,
                "polls": polls,
                "pages": 0,
                "text": "",
            }

        text, pages = _download_vision_text(job)
        return {
            "status": "done",
            "text": text,
            "pages": pages,
            "job_id": job_id,
            "polls": polls,
        }
    except Exception as exc:  # noqa: BLE001 — structured for /scan
        logger.debug("[ocr] vision job_id=%s error polls=%s", job_id, polls, exc_info=True)
        return {
            "status": "error",
            "detail": _friendly_vision_error(exc),
            "job_id": job_id,
            "polls": polls,
            "pages": 0,
            "text": "",
        }
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


# Vision sometimes describes a photo/scene instead of reading document text.
_SCENE_DESCRIPTION_RE = re.compile(
    r"(the image shows|this (photo|image|picture)|a person|"
    r"someone holding|holding a (notebook|paper|phone|document)|"
    r"in the (photo|image|picture)|the photo shows|appears to be a)",
    re.I,
)


def _is_unclear(text: str) -> bool:
    t = text.strip()
    if len(t) < 50:
        return True
    if _SCENE_DESCRIPTION_RE.search(t):
        return True
    return not any(c.isalpha() for c in t)


def _emit(progress, event: dict) -> None:
    if progress:
        progress(event)


def extract_document(
    file_bytes: bytes,
    filename: str,
    language: str = "te-IN",
    progress=None,
) -> dict:
    lang = language or "te-IN"
    file_hash = hashlib.sha256(file_bytes).hexdigest()
    # Same bytes + different OCR language must not share a cache entry.
    doc_id = hashlib.sha256(f"{file_hash}:{lang}".encode()).hexdigest()
    t0 = time.perf_counter()
    polls_total = 0

    def _finish(result: dict) -> dict:
        status = result.get("status") or ("done" if result.get("text") is not None else "error")
        if status == "unclear_scan":
            log_status = "done"
        elif status in {"done", "timeout", "error"}:
            log_status = status
        else:
            log_status = "done"
        logger.info(
            "[ocr] doc_id=%s status=%s total_ms=%s polls=%s pages=%s",
            doc_id[:12],
            log_status,
            int((time.perf_counter() - t0) * 1000),
            polls_total,
            result.get("pages") or 0,
        )
        return result

    hit = _cache.get(doc_id)
    if hit:
        _emit(
            progress,
            {
                "type": "progress",
                "stage": "ocr_started",
                "percent": 20,
                "message": f"Reading pages 1-{hit.get('pages', 1)} of {hit.get('pages', 1)}",
                "from_page": 1,
                "to_page": hit.get("pages", 1),
                "total_pages": hit.get("pages", 1),
            },
        )
        return _finish({**hit, "cached": True, "status": "done"})

    actual = _detect_format(file_bytes)
    if actual not in _FORMAT_EXT:
        raise ValueError("Unsupported file format; accepts PDF, PNG, JPG")

    if actual == "pdf":
        total_pages = _pdf_page_count(file_bytes)
    else:
        total_pages = 1

    deadline = time.perf_counter() + ocr_timeout_seconds()
    texts: list[str] = []
    pages = total_pages
    job_id = None

    if actual == "pdf" and total_pages > _VISION_MAX_PAGES:
        logger.info(
            "[vision] splitting %s pages into chunks of %s",
            total_pages,
            _VISION_MAX_PAGES,
        )
        chunk_index = 0
        for start in range(0, total_pages, _VISION_MAX_PAGES):
            end = min(start + _VISION_MAX_PAGES, total_pages)
            _emit(
                progress,
                {
                    "type": "progress",
                    "stage": "ocr_polling",
                    "percent": 40,
                    "message": f"Reading pages {start + 1}-{end} of {total_pages}",
                    "from_page": start + 1,
                    "to_page": end,
                    "total_pages": total_pages,
                },
            )
            if chunk_index > 0:
                remaining = deadline - time.perf_counter()
                if remaining <= 0.5:
                    return _finish(
                        {
                            "doc_id": doc_id,
                            "status": "timeout",
                            "detail": OCR_TIMEOUT_DETAIL,
                            "pages": 0,
                            "cached": False,
                            "text": "",
                        }
                    )
                pause = min(_VISION_CHUNK_GAP_S, max(0.0, remaining - 0.5))
                if pause > 0:
                    logger.info(
                        "[vision] rate-limit pause %.1fs before chunk %s",
                        pause,
                        chunk_index + 1,
                    )
                    time.sleep(pause)
            chunk_bytes = _pdf_slice(file_bytes, start, end)
            chunk_name = f"{Path(filename).stem or 'document'}-p{start + 1}-{end}.pdf"
            chunk = _run_vision(
                chunk_bytes,
                chunk_name,
                lang,
                progress=progress,
                deadline=deadline,
            )
            polls_total += int(chunk.get("polls") or 0)
            job_id = chunk.get("job_id") or job_id
            if chunk.get("status") in {"timeout", "error"}:
                return _finish(
                    {
                        "doc_id": doc_id,
                        "status": chunk["status"],
                        "detail": chunk.get("detail") or OCR_TIMEOUT_DETAIL,
                        "pages": 0,
                        "cached": False,
                        "text": "",
                        "job_id": job_id,
                    }
                )
            texts.append(chunk.get("text") or "")
            chunk_index += 1
        text = "\n\n".join(texts)
        pages = total_pages
    else:
        _emit(
            progress,
            {
                "type": "progress",
                "stage": "ocr_started",
                "percent": 20,
                "message": f"Reading pages 1-{total_pages} of {total_pages}",
                "from_page": 1,
                "to_page": total_pages,
                "total_pages": total_pages,
            },
        )
        vision = _run_vision(
            file_bytes,
            filename,
            lang,
            progress=progress,
            deadline=deadline,
        )
        polls_total += int(vision.get("polls") or 0)
        job_id = vision.get("job_id")
        if vision.get("status") in {"timeout", "error"}:
            return _finish(
                {
                    "doc_id": doc_id,
                    "status": vision["status"],
                    "detail": vision.get("detail") or OCR_TIMEOUT_DETAIL,
                    "pages": 0,
                    "cached": False,
                    "text": "",
                    "job_id": job_id,
                }
            )
        text = vision.get("text") or ""
        pages = int(vision.get("pages") or 1)
        if actual == "pdf":
            pages = total_pages

    if _is_unclear(text):
        return _finish(
            {
                "doc_id": doc_id,
                "text": text,
                "pages": pages,
                "cached": False,
                "status": "unclear_scan",
                "job_id": job_id,
            }
        )
    result = {
        "doc_id": doc_id,
        "text": text,
        "pages": pages,
        "cached": False,
        "status": "done",
        "job_id": job_id,
    }
    _set_cached_document(doc_id, {"doc_id": doc_id, "text": text, "pages": pages})
    return _finish(result)
