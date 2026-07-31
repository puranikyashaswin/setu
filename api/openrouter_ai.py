"""OpenRouter providers for Setu — chat, free Indic TTS, optional STT."""

from __future__ import annotations

import base64
import logging
import os
import time
from typing import Any

import httpx

logger = logging.getLogger("setu")

OPENROUTER_BASE = "https://openrouter.ai/api/v1"
DEFAULT_CHAT_MODEL = "nvidia/nemotron-3-nano-30b-a3b:free"
DEFAULT_TTS_MODEL = "fish-audio/s2.1-pro-free:free"
DEFAULT_STT_MODEL = "openai/whisper-large-v3"

# Indian languages Setu supports (+ English).
INDIAN_LANGS = frozenset(
    {"te", "hi", "en", "mr", "ta", "kn", "bn", "gu", "ml", "pa", "or", "od"}
)


def api_key() -> str:
    return (os.getenv("OPENROUTER_API_KEY") or "").strip()


def require_key() -> str:
    key = api_key()
    if not key:
        raise RuntimeError("OPENROUTER_API_KEY not set — add it to .env")
    return key


def _headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {require_key()}",
        "Content-Type": "application/json",
        "HTTP-Referer": os.getenv("FRONTEND_ORIGIN") or "http://localhost:3000",
        "X-Title": "Setu",
    }


def chat_model() -> str:
    return (os.getenv("OPENROUTER_CHAT_MODEL") or DEFAULT_CHAT_MODEL).strip()


def tts_model() -> str:
    return (os.getenv("OPENROUTER_TTS_MODEL") or DEFAULT_TTS_MODEL).strip()


def stt_model() -> str:
    return (os.getenv("OPENROUTER_STT_MODEL") or DEFAULT_STT_MODEL).strip()


def chat_completions(
    messages: list[dict[str, Any]],
    *,
    model: str | None = None,
    max_tokens: int = 400,
    temperature: float = 0.2,
    response_format: dict | None = None,
    tools: list[dict] | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "model": model or chat_model(),
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
    }
    if response_format:
        payload["response_format"] = response_format
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"

    t0 = time.perf_counter()
    with httpx.Client(timeout=httpx.Timeout(60.0, connect=10.0)) as client:
        response = client.post(
            f"{OPENROUTER_BASE}/chat/completions",
            headers=_headers(),
            json=payload,
        )
    if response.status_code >= 400:
        raise RuntimeError(f"OpenRouter chat {response.status_code}: {response.text[:400]}")
    body = response.json()
    logger.info(
        "[or-chat] model=%s in %.2fs",
        body.get("model") or payload["model"],
        time.perf_counter() - t0,
    )
    return body


def message_text(body: dict[str, Any]) -> str:
    choice = ((body.get("choices") or [{}])[0].get("message") or {})
    content = choice.get("content") or ""
    if isinstance(content, list):
        content = " ".join(
            part.get("text", "") if isinstance(part, dict) else str(part) for part in content
        )
    return str(content).strip()


def tool_calls(body: dict[str, Any]) -> list[Any]:
    choice = ((body.get("choices") or [{}])[0].get("message") or {})
    return list(choice.get("tool_calls") or [])


def speak_mp3(text: str, *, language: str = "en", pace: float = 1.0) -> bytes:
    """Free Fish TTS — returns MP3 bytes. Works with Indic scripts."""
    cleaned = (text or "").strip()
    if not cleaned:
        raise ValueError("Empty TTS text")
    payload: dict[str, Any] = {
        "model": tts_model(),
        "input": cleaned[:2200],
        "response_format": "mp3",
    }
    # Fish free ignores unknown voices; omit voice for provider default.
    t0 = time.perf_counter()
    with httpx.Client(timeout=httpx.Timeout(45.0, connect=10.0)) as client:
        response = client.post(
            f"{OPENROUTER_BASE}/audio/speech",
            headers=_headers(),
            json=payload,
        )
    if response.status_code >= 400:
        raise RuntimeError(f"OpenRouter TTS {response.status_code}: {response.text[:400]}")
    audio = response.content
    if not audio or response.headers.get("content-type", "").startswith("application/json"):
        raise RuntimeError(f"OpenRouter TTS returned no audio: {response.text[:300]}")
    logger.info(
        "[or-tts] model=%s lang=%s chars=%s bytes=%s in %.2fs",
        tts_model(),
        language,
        len(cleaned),
        len(audio),
        time.perf_counter() - t0,
    )
    _ = pace  # Fish free ignores pace; kept for API compatibility.
    return audio


def transcribe(
    audio_bytes: bytes,
    *,
    filename: str = "audio.wav",
    language: str | None = None,
) -> dict[str, str]:
    """OpenRouter STT — requires account credits (~$0.50 minimum for audio)."""
    fmt = "wav"
    lower = filename.lower()
    if lower.endswith(".mp3"):
        fmt = "mp3"
    elif lower.endswith(".webm"):
        fmt = "webm"
    elif lower.endswith(".m4a"):
        fmt = "m4a"

    payload: dict[str, Any] = {
        "model": stt_model(),
        "input_audio": {
            "data": base64.b64encode(audio_bytes).decode("ascii"),
            "format": fmt,
        },
    }
    if language:
        payload["language"] = language.split("-", 1)[0].lower()
        if payload["language"] == "or":
            payload["language"] = "or"

    t0 = time.perf_counter()
    with httpx.Client(timeout=httpx.Timeout(60.0, connect=10.0)) as client:
        response = client.post(
            f"{OPENROUTER_BASE}/audio/transcriptions",
            headers=_headers(),
            json=payload,
        )
    if response.status_code == 402:
        raise RuntimeError(
            "OpenRouter STT needs credits (add ~$0.50 at openrouter.ai/settings/credits). "
            "Or use browser speech recognition."
        )
    if response.status_code >= 400:
        raise RuntimeError(f"OpenRouter STT {response.status_code}: {response.text[:400]}")
    body = response.json()
    text = (body.get("text") or body.get("transcript") or "").strip()
    lang = body.get("language") or language or ""
    logger.info(
        "[or-stt] model=%s chars=%s in %.2fs",
        body.get("model") or stt_model(),
        len(text),
        time.perf_counter() - t0,
    )
    return {"transcript": text, "language_code": str(lang)}
