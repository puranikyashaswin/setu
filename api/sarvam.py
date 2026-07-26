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
import time
import zipfile
from pathlib import Path

logger = logging.getLogger("setu")

import httpx
from dotenv import load_dotenv
from sarvamai import SarvamAI
from sarvamai.core.api_error import ApiError

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

_cache: dict[str, dict] = {}
_CACHE_DIR = Path(__file__).resolve().parent / "cache"
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
# Only these may hit sarvam-30b via /converse. Everything else redirects to /ask.
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

You answer questions about government documents using ONLY the document text provided.
User-stated corrections (if provided) are personal facts from the user about themselves — NOT document content. Use them to personalize answers when relevant. NEVER put them in evidence quotes; evidence must stay verbatim from the document only.
Rules:
1. Use ONLY the document text for document facts. Never use outside knowledge. User-stated corrections may personalize the answer but are not document evidence.
2. SUMMARY / OVERVIEW requests (what is this about, what does it say, explain this, tell me what's in it, "అదే దాని గురించే చెప్పు", and similar): ALWAYS answer from the document content with status="verified_document" and abstain=false. Never abstain on these — the document text is right there.
3. Only abstain (status="not_found", abstain=true) when the user asks for a SPECIFIC FACT that is genuinely absent from the document — a date, an amount, a name, a deadline that does not appear in the text. Do NOT answer a related or adjacent fact instead. Example: if asked for a "last date" but the document only has a "start date", abstain — do not answer about the start date.
4. When abstaining, answer must still be a natural sentence in {language_name} explaining what is missing and what IS available in the document.
5. Every evidence.quote must be copied verbatim from the document text.
6. Keep answer to at most 2 short sentences — it will be spoken aloud.
7. When status is verified_document, include 1–3 short verbatim evidence quotes with page numbers. When abstaining, evidence must be empty.
8. action_items: only concrete citizen next-steps from the document; use [] if none.

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


def speak(
    text: str, language: str, speaker: str = "shubh", pace: float = 1.0
) -> bytes:
    client = get_client()
    voice = resolve_speaker(speaker)
    lang = _lang_code(language)

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
        resp = _with_backoff(call)
    except Exception as exc:
        logger.error(
            "[speak] TTS failed language=%s speaker=%s: %s",
            lang,
            voice,
            exc,
        )
        raise
    return _tts_to_wav(resp)


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
_client = SarvamAI(api_subscription_key=os.environ["SARVAM_API_KEY"])


def get_client() -> SarvamAI:
    return _client


def get_document(doc_id: str) -> dict | None:
    return _cache.get(doc_id)


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


def chat_reply(
    message: str,
    language: str,
    has_document: bool,
    history: list[dict] | None = None,
) -> dict:
    """Fast path: sarvam-30b, no document, no JSON schema. Target <1.5s."""
    language_name = _language_name(language)
    if has_document:
        doc_rule = (
            "A document is already loaded. NEVER ask the user to paste, upload, "
            "show, or scan a document."
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
        f"You are Setu, a helpful voice assistant for India. {doc_rule} "
        "Use prior conversation turns for follow-ups. A language switch is not a new "
        "conversation: never greet the user again or restart the introduction after one. "
        "Reply in ONE short sentence. "
        f"CRITICAL: Your entire reply must be in {language_name} script only."
    )
    history_msgs = _cap_chat_history(history, requested_language=language)
    lang_after = (
        f"CRITICAL LANGUAGE OVERRIDE: Ignore the language of any earlier turns. "
        f"Your entire next reply must be in {language_name} only "
        f"(native script for {language_name})."
    )
    user_content = (
        f"has_document={str(has_document).lower()}\n"
        f"User: {message}\n"
        f"(Reply in {language_name}.)"
    )
    messages = [
        {"role": "system", "content": system},
        *history_msgs,
        {"role": "system", "content": lang_after},
        {"role": "user", "content": user_content},
    ]
    _log_messages("/converse", messages)

    def call():
        return _client.chat.completions(
            model="sarvam-30b",
            messages=messages,
            reasoning_effort=None,  # required — thinking + low max_tokens → empty content
            max_tokens=60,
            temperature=0.2,
        )

    resp = _with_backoff(call)
    content = resp.choices[0].message.content
    if not content:
        raise RuntimeError("Empty model response")
    return {
        "reply": content.strip(),
        "intent": _chat_intent(message, has_document),
    }


def _is_short_factual_question(question: str) -> bool:
    """Fast /ask path: short, factual lookups — not summaries or open-ended explainers."""
    text = (question or "").strip()
    if not text:
        return False
    words = text.split()
    if len(words) > 14:
        return False
    if re.search(
        r"\b(about|explain|summarize|summary|overview|describe|tell me everything|"
        r"what does it say|what is this document|అదే|గురించ|बताओ|वर्णन|"
        r"explain this|what's in)\b",
        text,
        re.I,
    ):
        return False
    if _DOC_QUESTION_RE.search(text):
        return True
    return len(words) <= 8


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
    model = "sarvam-30b" if use_fast else "sarvam-105b"
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
    return result


def summarize_document(doc_text: str, answer_language: str) -> str:
    """Fast post-scan overview — sarvam-30b, 2–3 sentences, no verification schema."""
    client = get_client()
    clipped = (doc_text or "")[:6000]
    lang_name = _language_name(answer_language)
    messages = [
        {
            "role": "system",
            "content": (
                f"You summarize government documents for citizens. "
                f"Reply in {lang_name} only (native script). "
                "Write exactly 2–3 short sentences. No bullet points, no headers."
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
                model="sarvam-30b",
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
        f"[summarize] model=sarvam-30b sarvam_call={stats['call_ms']}ms "
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
    if isinstance(exc, ApiError):
        return exc.status_code in (429, 503)
    if isinstance(exc, httpx.HTTPStatusError):
        return exc.response.status_code in (429, 503)
    return False


def _error_status(exc: BaseException) -> object:
    if isinstance(exc, ApiError):
        return exc.status_code
    if isinstance(exc, httpx.HTTPStatusError):
        return exc.response.status_code
    return type(exc).__name__


def _with_backoff(fn, *, max_retries: int = 2):
    delay = 0.5
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
            delay *= 2
    raise last  # ponytail: unreachable unless max_retries==0


_VISION_MAX_PAGES = 10
# Vision rate limit ≈ 10 req/min — wait between sequential chunk jobs.
_VISION_CHUNK_GAP_S = 6.5


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


def _run_vision(file_bytes: bytes, filename: str, language: str = "te-IN") -> tuple[str, int]:
    actual = _detect_format(file_bytes)
    if actual not in _FORMAT_EXT:
        raise ValueError("Unsupported file format; accepts PDF, PNG, JPG")

    upload_name = _correct_filename(filename, actual)
    client = get_client()
    lang = language or "te-IN"

    def create_job():
        return client.document_intelligence.create_job(language=lang, output_format="md")

    job = _with_backoff(create_job)

    with tempfile.NamedTemporaryFile(suffix=Path(upload_name).suffix, delete=False) as tmp:
        tmp.write(file_bytes)
        tmp_path = tmp.name

    try:
        _with_backoff(lambda: job.upload_file(tmp_path))
        _with_backoff(job.start)
        status = _with_backoff(job.wait_until_complete)
        if status.job_state == "Failed":
            raise RuntimeError(f"Vision job failed: {status.job_state}")

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
    finally:
        os.unlink(tmp_path)


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
    hit = _cache.get(doc_id)
    if hit:
        _emit(
            progress,
            {
                "type": "progress",
                "message": f"Reading pages 1-{hit.get('pages', 1)} of {hit.get('pages', 1)}",
                "from_page": 1,
                "to_page": hit.get("pages", 1),
                "total_pages": hit.get("pages", 1),
            },
        )
        return {**hit, "cached": True}

    actual = _detect_format(file_bytes)
    if actual not in _FORMAT_EXT:
        raise ValueError("Unsupported file format; accepts PDF, PNG, JPG")

    if actual == "pdf":
        total_pages = _pdf_page_count(file_bytes)
    else:
        total_pages = 1

    texts: list[str] = []
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
                    "message": f"Reading pages {start + 1}-{end} of {total_pages}",
                    "from_page": start + 1,
                    "to_page": end,
                    "total_pages": total_pages,
                },
            )
            if chunk_index > 0:
                logger.info(
                    "[vision] rate-limit pause %.1fs before chunk %s",
                    _VISION_CHUNK_GAP_S,
                    chunk_index + 1,
                )
                time.sleep(_VISION_CHUNK_GAP_S)
            chunk_bytes = _pdf_slice(file_bytes, start, end)
            chunk_name = f"{Path(filename).stem or 'document'}-p{start + 1}-{end}.pdf"
            chunk_text, _ = _run_vision(chunk_bytes, chunk_name, lang)
            texts.append(chunk_text)
            chunk_index += 1
        text = "\n\n".join(texts)
        pages = total_pages
    else:
        _emit(
            progress,
            {
                "type": "progress",
                "message": f"Reading pages 1-{total_pages} of {total_pages}",
                "from_page": 1,
                "to_page": total_pages,
                "total_pages": total_pages,
            },
        )
        text, pages = _run_vision(file_bytes, filename, lang)
        # Prefer pre-count for PDFs when metrics are missing/wrong.
        if actual == "pdf":
            pages = total_pages

    if _is_unclear(text):
        return {
            "doc_id": doc_id,
            "text": text,
            "pages": pages,
            "cached": False,
            "status": "unclear_scan",
        }
    result = {"doc_id": doc_id, "text": text, "pages": pages, "cached": False}
    _set_cached_document(doc_id, {"doc_id": doc_id, "text": text, "pages": pages})
    return result
