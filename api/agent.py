"""Tool-calling voice agent — routes turns into concrete actions Setu can execute."""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from collections.abc import Callable
from typing import Any

import openrouter_ai
import sarvam
from doc_retrieve import retrieve_chunks

logger = logging.getLogger("setu")

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
    text = (message or "").strip().lower()
    if not text:
        return None
    for code, names in _LANG_NAME_HINTS.items():
        for name in names:
            if name.lower() not in text:
                continue
            if re.fullmatch(rf"[\s.!?]*{re.escape(name.lower())}[\s.!?]*", text):
                return code
            if re.search(
                rf"\b(speak|talk|switch|change|use|set|in|to|language)\b.*{re.escape(name.lower())}"
                rf"|{re.escape(name.lower())}.*\b(language|లో|में|में)\b",
                text,
                re.I,
            ):
                return code
            if len(text.split()) <= 4 and name.lower() in text:
                return code
    return None


def is_language_switch_only(message: str, code: str) -> bool:
    text = (message or "").strip().lower()
    names = _LANG_NAME_HINTS.get(code, ())
    stripped = re.sub(
        r"\b(can|could|would|will|please|speak|talk|switch|change|use|set|the|language|in|into|to|me)\b",
        " ",
        text,
        flags=re.I,
    )
    stripped = re.sub(r"\s+", " ", stripped).strip(" .!?")
    return stripped in {n.lower() for n in names} or stripped == code


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
    result = sarvam.ask_document(
        context or doc["text"],
        question,
        language,
        history=history,
        corrections=corrections,
    )
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
    def call():
        return openrouter_ai.chat_completions(
            messages,
            tools=AGENT_TOOLS,
            max_tokens=256,
            temperature=0.0,
        )

    try:
        resp = sarvam._with_backoff(call)  # noqa: SLF001 — shared retry helper
    except Exception:
        logger.warning("agent tool route failed", exc_info=True)
        return None

    tool_calls = openrouter_ai.tool_calls(resp)
    if not tool_calls:
        content = openrouter_ai.message_text(resp)
        if content:
            return AgentResult(
                route="converse",
                reply=content,
                language=language,
                model_used=openrouter_ai.chat_model(),
                tools_used=["chat_direct"],
                spoken_parts=_split_spoken_parts(content),
            )
        return None

    call0 = tool_calls[0]
    # OpenAI-compatible shape: function.name / function.arguments
    fn = call0.get("function") if isinstance(call0, dict) else getattr(call0, "function", None)
    if isinstance(fn, dict):
        name = fn.get("name") or ""
        raw_args = fn.get("arguments") or "{}"
    else:
        name = getattr(fn, "name", "") or ""
        raw_args = getattr(fn, "arguments", None) or "{}"
    try:
        args = json.loads(raw_args) if isinstance(raw_args, str) else dict(raw_args or {})
    except json.JSONDecodeError:
        args = {}

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
        chat = sarvam.chat_reply(
            str(args.get("message") or transcript),
            language,
            has_document,
            history=history,
            memory_context=memory,
        )
        reply = chat.get("reply", "")
        intent = chat.get("intent", "chat")
        if not has_document and (intent == "needs_document" or wants_document(transcript)):
            return AgentResult(
                route="open_camera",
                reply=sarvam.camera_phrase(language, "show"),
                language=language,
                intent=intent,
                open_camera=True,
                continue_listening=False,
                    model_used=openrouter_ai.chat_model(),
                    tools_used=[name],
                )
        return AgentResult(
            route="converse",
            reply=reply,
            language=language,
            intent=intent,
            model_used=openrouter_ai.chat_model(),
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
    requested = detect_language_request(transcript)
    if requested:
        reply_language = requested
    route = (force_route or "").strip().lower() or None

    # Deterministic onboarding / language / camera paths (lowest latency, most reliable).
    if route == "intro" or not onboarded:
        if requested:
            reply_language = requested
        reply = sarvam.intro_for_language(reply_language)
        return AgentResult(
            route="intro",
            reply=reply,
            language=reply_language,
            max_spoken=160,
            spoken_parts=[reply],
        )

    if route == "language_switch" or (
        not route and requested and is_language_switch_only(transcript, requested)
    ):
        reply = sarvam.language_switch_for_language(reply_language)
        return AgentResult(
            route="language_switch",
            reply=reply,
            language=reply_language,
            max_spoken=40,
            spoken_parts=[reply],
        )

    if route == "open_camera" or (
        not route and wants_document(transcript) and (not has_document or not doc_id)
    ):
        reply = sarvam.camera_phrase(reply_language, "show")
        return AgentResult(
            route="open_camera",
            reply=reply,
            language=reply_language,
            open_camera=True,
            continue_listening=False,
            max_spoken=80,
            spoken_parts=[reply],
        )

    if route == "ask" or (
        not route and has_document and doc_id and is_substantive(transcript)
    ):
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
        return AgentResult(
            route="ack",
            reply=reply,
            language=reply_language,
            max_spoken=40,
            spoken_parts=[reply],
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
            return tooled

    # Fallback converse / ask redirect.
    if has_document and not sarvam.is_converse_allowed(transcript) and doc_id:
        return _run_ask(
            doc_id=doc_id,
            question=transcript,
            language=reply_language,
            history=history_msgs,
            session_id=session_id,
        )

    chat = sarvam.chat_reply(
        transcript,
        reply_language,
        has_document,
        history=history_msgs,
        memory_context=memory,
    )
    reply = chat.get("reply", "")
    intent = chat.get("intent", "chat")
    if not has_document and (intent == "needs_document" or wants_document(transcript)):
        cam = sarvam.camera_phrase(reply_language, "show")
        return AgentResult(
            route="open_camera",
            reply=cam,
            language=reply_language,
            intent=intent,
            open_camera=True,
            continue_listening=False,
            model_used="openrouter",
            spoken_parts=[cam],
        )
    return AgentResult(
        route="converse",
        reply=reply,
        language=reply_language,
        intent=intent,
        model_used="openrouter",
        spoken_parts=_split_spoken_parts(reply),
    )


def synthesize_turn_audio(
    result: AgentResult,
    *,
    pace: float = 1.0,
    cancelled: Callable[[], bool] | None = None,
) -> tuple[bytes, list[bytes]]:
    """Return (combined_mp3, [combined_mp3]). One Fish TTS call — MP3, not WAV."""
    if cancelled and cancelled():
        return b"", []
    parts = result.spoken_parts or _split_spoken_parts(result.reply, result.max_spoken)
    spoken = " ".join(p.strip() for p in parts if p.strip())
    if not spoken:
        spoken = sarvam.spoken_text(result.reply, result.max_spoken) or result.reply or "Okay."
    audio = sarvam.speak(spoken, result.language, speaker="setu", pace=pace)
    return audio, [audio]
