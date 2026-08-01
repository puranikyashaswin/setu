"""Tool-calling voice agent — routes turns into concrete actions Setu can execute."""

from __future__ import annotations

import json
import logging
import re
import time
import unicodedata
from dataclasses import dataclass, field
from collections.abc import Callable
from typing import Any

import sarvam
from doc_retrieve import retrieve_chunks

logger = logging.getLogger("setu")

_BCP47: dict[str, str] = {
    "te": "te-IN",
    "hi": "hi-IN",
    "en": "en-IN",
    "mr": "mr-IN",
    "ta": "ta-IN",
    "kn": "kn-IN",
    "bn": "bn-IN",
    "gu": "gu-IN",
    "ml": "ml-IN",
    "pa": "pa-IN",
    "or": "or-IN",
}


def _voice_log(session_id: str | None, event: str, **fields: Any) -> None:
    """Forward to voice_ws ring buffer; never raise (avoids import cycles at module load)."""
    try:
        from voice_ws import voice_log

        voice_log(session_id, event, **fields)
    except Exception:
        # Fallback so agent logs still appear if WS module is unavailable.
        extras = " ".join(f"{k}={v}" for k, v in fields.items())
        logger.info("[voice] session=%s event=%s %s", session_id or "-", event, extras)


def _route_intent_label(route: str, intent: str | None = None) -> str:
    if intent in {
        "language_switch",
        "scan",
        "ask",
        "chat",
        "ack",
        "fallback",
    }:
        return intent
    return {
        "language_switch": "language_switch",
        "open_camera": "scan",
        "ask": "ask",
        "ack": "ack",
        "converse": "chat",
        "intro": "chat",
    }.get(route, "fallback")


def to_bcp47(language: str | None) -> str:
    base = (language or "en").strip().lower().split("-", 1)[0]
    if base == "od":
        base = "or"
    return _BCP47.get(base, "en-IN")


def normalize_utterance(message: str) -> str:
    """NFKC + lowercase Roman + strip punctuation noise from STT."""
    text = unicodedata.normalize("NFKC", message or "")
    text = text.strip().lower()
    text = re.sub(r"[.!?,;:\"'`…]+", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text

_WANTS_DOC_RE = (
    r"(i have (a |the )?document|show (you )?(my |the )?document|"
    r"scan (this |my |the )?(document|paper|notice)|document ఉంది|నా దగ్గర|"
    r"చూపించ|दस्तावेज|काग[ज़ज]|कागद|"
    r"मेरे पास|mera pass|mere paas|देख के बता|यह देख|ये देख|"
    r"दिखाऊंगा|दिखाऊँगा|दिखा|camera|कैमरा|camra|"
    r"camera\s*(on|खोल)|on\s*kar)"
)
_DOC_MENTION_RE = (
    r"(document|notice|paper|form|scan|read this|camera|कैमरा|"
    r"दस्तावेज|काग[ज़ज]|नोटिस|"
    r"పత్రం|నోటీసు|ದಾಖಲೆ|ஆவணம்|নথি|દસ્તાવેજ|രേഖ|ਦਸਤਾਵੇਜ਼|ଦଲିଲ)"
)
_SMALL_TALK_RE = (
    r"^(hi|hello|hey|thanks|thank you|thankyou|bye|goodbye|good morning|"
    r"good evening|నమస్కారం|ధన్యవాదాలు|नमस्ते|धन्यवाद|வணக்கம்|ನಮಸ್ಕಾರ|"
    r"नमस्कार|নমস্কার)\b"
)
_ACK_RE = (
    r"^(okay|ok|k|hmm+|hm+|uh+h?|um+|yes|yeah|yep|yup|no|nope|nah|thanks|"
    r"thank you|thankyou|thx|right|correct|got it|gotcha|sure|fine|alright|"
    r"all right|achha|accha|haan|han|ha|ji|theek|thik|sari|seri|aam|ho|"
    r"barobar|సరే|అవును|అలాగే|हाँ|हां|ठीक|अच्छा|சரி|होय|बरोबर|ঠিক|હા|"
    r"അതെ|ਹਾਂ|ହଁ)[.!?\s]*$"
)
_QUESTION_RE = (
    r"\?|\b(what|when|where|who|why|how|which|can|could|should|would|is|are|"
    r"do|does|did|will|shall|kya|kaun|kab|kahan|kaise|kitna|kitni|kyun)\b"
)

_LANG_NAME_HINTS: dict[str, tuple[str, ...]] = {
    "te": ("telugu", "తెలుగు", "तेलुगु"),
    "hi": ("hindi", "हिंदी", "हिन्दी", "హిందీ"),
    "en": ("english", "angrezi", "ఇంగ్లీష్", "अंग्रेजी"),
    "mr": ("marathi", "मराठी"),
    "ta": ("tamil", "தமிழ்"),
    "kn": ("kannada", "ಕನ್ನಡ"),
    "bn": ("bengali", "bangla", "বাংলা"),
    "gu": ("gujarati", "ગુજરાતી"),
    "ml": ("malayalam", "മലയാളം"),
    "pa": ("punjabi", "ਪੰਜਾਬੀ"),
    "or": ("odia", "oriya", "ଓଡ଼ିଆ"),
}

# Preference / switch cues (Roman + common Indic patterns).
_LANG_PREF_RE = re.compile(
    r"(?:\b(?:i\s+speak|i\s+want|speak|talk|switch|change|use|set|prefer|language|"
    r"matladu|matladutanu|matladutunnanu|matladali|baat|bolo|bolna|mein|me|"
    r"nenu|lo)\b|"
    r"में\s*बात|बात\s*करो|లో\s*మాట్లాడ|మాట్లాడు)",
    re.I,
)
_LANG_QUESTION_RE = re.compile(
    r"\b(what|who|where|when|why|how|which|tell\s+me\s+about|meaning\s+of|"
    r"difference|history)\b",
    re.I,
)

AGENT_TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "ask_document",
            "description": (
                "Answer a question using the currently loaded document. "
                "Use when the user asks about eligibility, dates, fees, amounts, process, or anything in the scan."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "question": {"type": "string", "description": "The user question to answer from the document."},
                },
                "required": ["question"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "open_camera",
            "description": "Open the camera so the user can show a new document for scanning.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "switch_language",
            "description": "Switch the spoken reply language.",
            "parameters": {
                "type": "object",
                "properties": {
                    "language": {
                        "type": "string",
                        "enum": ["en", "hi", "te", "mr", "ta", "kn", "bn", "gu", "ml", "pa", "or"],
                    },
                },
                "required": ["language"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "brief_ack",
            "description": "Give a short acknowledgment when the user only said okay/yes/thanks/hmm.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "chat",
            "description": (
                "General conversation, memory recall, help, or small talk when no document answer is needed."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "message": {"type": "string", "description": "User message to answer in chat mode."},
                },
                "required": ["message"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "remember_fact",
            "description": "Store a personal correction or fact the user stated about themselves.",
            "parameters": {
                "type": "object",
                "properties": {
                    "field": {"type": "string"},
                    "value": {"type": "string"},
                },
                "required": ["field", "value"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "summarize_document",
            "description": "Summarize the currently loaded document briefly for speech.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
]


@dataclass
class AgentResult:
    route: str
    reply: str
    language: str
    intent: str = "chat"
    open_camera: bool = False
    continue_listening: bool = True
    max_spoken: int = 200
    model_used: str | None = None
    ask: dict | None = None
    tools_used: list[str] = field(default_factory=list)
    spoken_parts: list[str] = field(default_factory=list)


def detect_language_request(message: str) -> str | None:
    """Return base language code when the user is selecting/switching spoken language."""
    text = normalize_utterance(message)
    if not text:
        return None

    # Exact / near-exact name: "Telugu", "తెలుగు.", "English"
    for code, names in _LANG_NAME_HINTS.items():
        for name in names:
            n = normalize_utterance(name)
            if not n:
                continue
            if text == n or text == code:
                return code

    # Natural preference phrases containing a language name.
    hits: list[tuple[str, str]] = []
    for code, names in _LANG_NAME_HINTS.items():
        for name in names:
            n = normalize_utterance(name)
            if not n:
                continue
            if re.search(rf"(?<!\w){re.escape(n)}(?!\w)", text) or n in text:
                hits.append((code, n))
    if not hits:
        return None

    # Prefer the longest matched name (hindi vs hi edge cases).
    hits.sort(key=lambda item: len(item[1]), reverse=True)
    code = hits[0][0]

    # "what is telugu" → not a switch; "i speak telugu" / "telugu lo matladu" → switch.
    if _LANG_QUESTION_RE.search(text) and not _LANG_PREF_RE.search(text):
        return None
    if _LANG_PREF_RE.search(text):
        return code
    if len(text.split()) <= 6:
        return code
    return None


def is_language_switch_only(message: str, code: str) -> bool:
    """True when the utterance is (only) a language pick/switch for `code`."""
    detected = detect_language_request(message)
    return detected == code


def wants_document(message: str) -> bool:
    return bool(
        re.search(_WANTS_DOC_RE, message, re.I)
        or re.search(_DOC_MENTION_RE, message, re.I)
    )


def is_substantive(message: str) -> bool:
    text = (message or "").strip()
    if not text:
        return False
    if re.search(_ACK_RE, text, re.I):
        return False
    if re.search(_SMALL_TALK_RE, text, re.I) and not re.search(_QUESTION_RE, text, re.I):
        return False
    if re.search(_QUESTION_RE, text, re.I):
        return True
    if sarvam.is_converse_allowed(text):
        return False
    return len(text.split()) >= 3


def _split_spoken_parts(text: str, max_chars: int = 200) -> list[str]:
    spoken = sarvam.spoken_text(text, max_chars)
    if not spoken:
        return []
    parts = re.split(r"(?<=[.!?।])\s+", spoken)
    cleaned = [p.strip() for p in parts if p.strip()]
    return cleaned or [spoken]


def _run_ask(
    *,
    doc_id: str,
    question: str,
    language: str,
    history: list[dict],
    session_id: str | None,
) -> AgentResult:
    doc = sarvam.get_document(doc_id)
    if not doc:
        return AgentResult(
            route="open_camera",
            reply=sarvam.camera_phrase(language, "show"),
            language=language,
            intent="needs_document",
            open_camera=True,
            continue_listening=False,
            max_spoken=80,
            tools_used=["ask_document"],
        )
    session_key = (session_id or "").strip()
    corrections = (
        sarvam.ingest_corrections_from_utterance(session_key, question) if session_key else []
    )
    context = retrieve_chunks(doc["text"], question)
    _voice_log(session_id, "llm_start")
    t_llm = time.perf_counter()
    try:
        result = sarvam.ask_document(
            context or doc["text"],
            question,
            language,
            history=history,
            corrections=corrections,
        )
    except Exception as exc:
        _voice_log(session_id, "error", stage="llm", detail=str(exc))
        raise
    evidence = sarvam.verify_citations(result.get("evidence") or [], doc["text"])
    status = result.get("status", "not_found")
    if any(not item.get("verified") for item in evidence):
        if status == "verified_document":
            status = "not_found"
    all_verified = (
        bool(evidence)
        and all(item.get("verified") for item in evidence)
        and status == "verified_document"
    )
    reply = result.get("answer", "")
    model_used = result.get("model_used")
    _voice_log(
        session_id,
        "llm_done",
        ms=int((time.perf_counter() - t_llm) * 1000),
        reply_chars=len(reply or ""),
    )
    ask_payload = {
        "answer": reply,
        "language": result.get("language", language),
        "status": status,
        "action_items": result.get("action_items") or [],
        "evidence": evidence,
        "abstain": bool(result.get("abstain", False)),
        "all_verified": all_verified,
        "corrections": corrections,
        "model_used": model_used,
    }
    return AgentResult(
        route="ask",
        reply=reply,
        language=language,
        intent="document_question",
        model_used=model_used,
        ask=ask_payload,
        tools_used=["ask_document"],
        spoken_parts=_split_spoken_parts(reply),
    )


def _route_with_tools(
    transcript: str,
    *,
    language: str,
    has_document: bool,
    doc_id: str | None,
    history: list[dict],
    memory: str | None,
    session_id: str | None,
) -> AgentResult | None:
    """Ask the model which tool to run. Returns None on failure so caller can fall back."""
    lang_name = {
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
    }.get(language, "English")
    system = (
        f"You are Setu, a voice agent. Reply language must be {lang_name} ({language}). "
        f"has_document={bool(has_document and doc_id)}. "
        "If the user needs a specialized action, call exactly one tool. "
        "If it is normal conversation, memory recall, or help, answer directly in ONE or TWO short spoken sentences "
        f"in {lang_name} — do not call the chat tool for that. "
        "Tool rules: "
        "ask_document when a document is loaded and they ask about its contents; "
        "open_camera when they want to show/scan a document and none is loaded; "
        "switch_language for language changes; "
        "brief_ack for okay/yes/thanks/hmm; "
        "summarize_document for a short overview of the loaded document; "
        "remember_fact for personal corrections. "
        "Keep spoken answers short."
    )
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": transcript},
    ]
    client = sarvam.get_client()

    def call():
        return client.chat.completions(
            model="sarvam-105b",
            messages=messages,
            tools=AGENT_TOOLS,
            reasoning_effort=None,
            max_tokens=256,
            temperature=0.0,
        )

    _voice_log(session_id, "llm_start")
    t_llm = time.perf_counter()
    try:
        resp = sarvam._with_backoff(call)  # noqa: SLF001 — shared retry helper
    except Exception as exc:
        logger.warning("agent tool route failed", exc_info=True)
        _voice_log(session_id, "error", stage="llm", detail=str(exc))
        return None

    message = resp.choices[0].message
    tool_calls = getattr(message, "tool_calls", None) or []
    if not tool_calls:
        content = (getattr(message, "content", None) or "").strip()
        _voice_log(
            session_id,
            "llm_done",
            ms=int((time.perf_counter() - t_llm) * 1000),
            reply_chars=len(content or ""),
        )
        if content:
            return AgentResult(
                route="converse",
                reply=content,
                language=language,
                model_used="sarvam-105b",
                tools_used=["chat_direct"],
                spoken_parts=_split_spoken_parts(content),
            )
        return None

    call0 = tool_calls[0]
    name = call0.function.name
    try:
        args = json.loads(call0.function.arguments or "{}")
    except json.JSONDecodeError:
        args = {}

    # Classifier call finished; tool handlers may run a second LLM (ask/chat).
    _voice_log(
        session_id,
        "llm_done",
        ms=int((time.perf_counter() - t_llm) * 1000),
        reply_chars=0,
    )

    if name == "switch_language":
        code = str(args.get("language") or language).split("-", 1)[0]
        return AgentResult(
            route="language_switch",
            reply=sarvam.language_switch_for_language(code),
            language=code,
            max_spoken=40,
            tools_used=[name],
            spoken_parts=[sarvam.language_switch_for_language(code)],
        )
    if name == "open_camera":
        return AgentResult(
            route="open_camera",
            reply=sarvam.camera_phrase(language, "show"),
            language=language,
            open_camera=True,
            continue_listening=False,
            max_spoken=80,
            tools_used=[name],
            spoken_parts=[sarvam.camera_phrase(language, "show")],
        )
    if name == "brief_ack":
        reply = sarvam.brief_ack_for_language(language)
        return AgentResult(
            route="ack",
            reply=reply,
            language=language,
            max_spoken=40,
            tools_used=[name],
            spoken_parts=[reply],
        )
    if name == "remember_fact":
        field = str(args.get("field") or "").strip()
        value = str(args.get("value") or "").strip()
        if session_id and field and value:
            sarvam.ingest_corrections_from_utterance(session_id, f"my {field} is {value}")
        reply = sarvam.brief_ack_for_language(language)
        return AgentResult(
            route="ack",
            reply=reply,
            language=language,
            max_spoken=40,
            tools_used=[name],
            spoken_parts=[reply],
        )
    if name == "summarize_document":
        if not (has_document and doc_id):
            return AgentResult(
                route="open_camera",
                reply=sarvam.camera_phrase(language, "show"),
                language=language,
                open_camera=True,
                continue_listening=False,
                tools_used=[name],
            )
        return _run_ask(
            doc_id=doc_id,
            question="Give a short overview of this document.",
            language=language,
            history=history,
            session_id=session_id,
        )
    if name == "ask_document":
        if not (has_document and doc_id):
            return AgentResult(
                route="open_camera",
                reply=sarvam.camera_phrase(language, "show"),
                language=language,
                open_camera=True,
                continue_listening=False,
                tools_used=[name],
            )
        question = str(args.get("question") or transcript).strip() or transcript
        return _run_ask(
            doc_id=doc_id,
            question=question,
            language=language,
            history=history,
            session_id=session_id,
        )
    if name == "chat":
        _voice_log(session_id, "llm_start")
        t_chat = time.perf_counter()
        try:
            chat = sarvam.chat_reply(
                str(args.get("message") or transcript),
                language,
                has_document,
                history=history,
                memory_context=memory,
            )
        except Exception as exc:
            _voice_log(session_id, "error", stage="llm", detail=str(exc))
            raise
        reply = chat.get("reply", "")
        intent = chat.get("intent", "chat")
        _voice_log(
            session_id,
            "llm_done",
            ms=int((time.perf_counter() - t_chat) * 1000),
            reply_chars=len(reply or ""),
        )
        if not has_document and (intent == "needs_document" or wants_document(transcript)):
            return AgentResult(
                route="open_camera",
                reply=sarvam.camera_phrase(language, "show"),
                language=language,
                intent=intent,
                open_camera=True,
                continue_listening=False,
                model_used="sarvam-105b",
                tools_used=[name],
            )
        return AgentResult(
            route="converse",
            reply=reply,
            language=language,
            intent=intent,
            model_used="sarvam-105b",
            tools_used=[name],
            spoken_parts=_split_spoken_parts(reply),
        )

    logger.info("unknown tool %s — falling back", name)
    return None


def run_agent_turn(
    transcript: str,
    *,
    language: str = "en",
    has_document: bool = False,
    doc_id: str | None = None,
    history: list[dict] | None = None,
    memory: str | None = None,
    session_id: str | None = None,
    onboarded: bool = False,
    force_route: str | None = None,
    use_tools: bool = True,
) -> AgentResult:
    """Resolve a transcript into a speakable agent action."""
    history_msgs = history or []
    reply_language = (language or "en").split("-", 1)[0]
    if reply_language == "od":
        reply_language = "or"
    requested = detect_language_request(transcript)
    route = (force_route or "").strip().lower() or None
    t_route = time.perf_counter()

    def _decided(path: str, result: AgentResult) -> AgentResult:
        _voice_log(
            session_id,
            "route_decision",
            path=path,
            intent=_route_intent_label(result.route, result.intent),
            ms=int((time.perf_counter() - t_route) * 1000),
        )
        return result

    # 1) Language pick/switch BEFORE chat/classifier/onboarding catch-alls.
    if route == "language_switch" or (not route and requested):
        code = requested or reply_language
        bcp = to_bcp47(code)
        # Session language is the selected code; client persists it from this result.
        if not onboarded:
            reply = sarvam.intro_for_language(bcp)
            max_spoken = 220
        else:
            reply = sarvam.language_switch_for_language(bcp)
            max_spoken = 40
        return _decided(
            "regex",
            AgentResult(
                route="language_switch",
                intent="language_switch",
                reply=reply,
                language=bcp,
                max_spoken=max_spoken,
                spoken_parts=[reply],
            ),
        )

    # 2) Explicit scan / open camera — speak guide + open_camera; never auto-OCR.
    if route == "open_camera" or (
        not route and wants_document(transcript) and (not has_document or not doc_id)
    ):
        reply = sarvam.camera_phrase(reply_language, "show")
        return _decided(
            "regex",
            AgentResult(
                route="open_camera",
                intent="scan",
                reply=reply,
                language=to_bcp47(reply_language),
                open_camera=True,
                continue_listening=False,
                max_spoken=120,
                spoken_parts=[reply],
            ),
        )

    # Forced intro (client/onboarding helpers); language pick already handled above.
    if route == "intro":
        reply = sarvam.intro_for_language(reply_language)
        return _decided(
            "regex",
            AgentResult(
                route="intro",
                intent="chat",
                reply=reply,
                language=to_bcp47(reply_language),
                max_spoken=220,
                spoken_parts=[reply],
            ),
        )

    if route == "ask" or (
        not route and has_document and doc_id and is_substantive(transcript)
    ):
        _voice_log(
            session_id,
            "route_decision",
            path="regex",
            intent="ask",
            ms=int((time.perf_counter() - t_route) * 1000),
        )
        return _run_ask(
            doc_id=doc_id or "",
            question=transcript,
            language=reply_language,
            history=history_msgs,
            session_id=session_id,
        )

    if route == "ack" or (
        not route and has_document and doc_id and not is_substantive(transcript)
    ):
        reply = sarvam.brief_ack_for_language(reply_language)
        return _decided(
            "regex",
            AgentResult(
                route="ack",
                reply=reply,
                language=reply_language,
                max_spoken=40,
                spoken_parts=[reply],
            ),
        )

    # Open-ended routing via tools (ChatGPT-style tool agent).
    if use_tools and not route:
        tooled = _route_with_tools(
            transcript,
            language=reply_language,
            has_document=has_document,
            doc_id=doc_id,
            history=history_msgs,
            memory=memory,
            session_id=session_id,
        )
        if tooled:
            return _decided("classifier", tooled)

    # Fallback converse / ask redirect.
    if has_document and not sarvam.is_converse_allowed(transcript) and doc_id:
        _voice_log(
            session_id,
            "route_decision",
            path="fallback",
            intent="ask",
            ms=int((time.perf_counter() - t_route) * 1000),
        )
        return _run_ask(
            doc_id=doc_id,
            question=transcript,
            language=reply_language,
            history=history_msgs,
            session_id=session_id,
        )

    _voice_log(
        session_id,
        "route_decision",
        path="fallback",
        intent="chat",
        ms=int((time.perf_counter() - t_route) * 1000),
    )
    _voice_log(session_id, "llm_start")
    t_llm = time.perf_counter()
    try:
        chat = sarvam.chat_reply(
            transcript,
            reply_language,
            has_document,
            history=history_msgs,
            memory_context=memory,
        )
    except Exception as exc:
        _voice_log(session_id, "error", stage="llm", detail=str(exc))
        raise
    reply = (chat.get("reply") or "").strip()
    intent = chat.get("intent", "chat")
    if not reply:
        reply = sarvam.brief_ack_for_language(reply_language)
    _voice_log(
        session_id,
        "llm_done",
        ms=int((time.perf_counter() - t_llm) * 1000),
        reply_chars=len(reply or ""),
    )
    if not has_document and (intent == "needs_document" or wants_document(transcript)):
        cam = sarvam.camera_phrase(reply_language, "show")
        return AgentResult(
            route="open_camera",
            reply=cam,
            language=to_bcp47(reply_language),
            intent="scan",
            open_camera=True,
            continue_listening=False,
            model_used="sarvam-105b",
            spoken_parts=[cam],
        )
    return AgentResult(
        route="converse",
        reply=reply,
        language=to_bcp47(reply_language),
        intent="chat",
        model_used="sarvam-105b",
        spoken_parts=_split_spoken_parts(reply),
    )


def synthesize_turn_audio(
    result: AgentResult,
    *,
    pace: float = 1.0,
    cancelled: Callable[[], bool] | None = None,
) -> tuple[bytes, list[bytes]]:
    """Return (combined_wav, per_sentence_wavs). Stops early if cancelled()."""
    parts = result.spoken_parts or _split_spoken_parts(result.reply, result.max_spoken)
    if not parts:
        parts = [sarvam.spoken_text(result.reply, result.max_spoken) or result.reply]
    wavs: list[bytes] = []
    for part in parts:
        if cancelled and cancelled():
            break
        if not part.strip():
            continue
        wavs.append(sarvam.speak(part, result.language, speaker="shubh", pace=pace))
    if not wavs:
        spoken = sarvam.spoken_text(result.reply, result.max_spoken) or result.reply or "Okay."
        wavs = [sarvam.speak(spoken, result.language, speaker="shubh", pace=pace)]
    return wavs[0] if len(wavs) == 1 else _concat_wavs(wavs), wavs


def _concat_wavs(wavs: list[bytes]) -> bytes:
    if not wavs:
        return b""
    if len(wavs) == 1:
        return wavs[0]
    combined = wavs[0]
    for chunk in wavs[1:]:
        data_pos = chunk.find(b"data")
        if data_pos >= 0:
            combined += chunk[data_pos + 8 :]
        else:
            combined += chunk
    # Best-effort: leave header from first chunk; browsers tolerate approximate sizes for PCM WAV.
    return combined
