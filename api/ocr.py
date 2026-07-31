"""Document OCR via OpenRouter vision models (+ PDF text-layer fast path)."""

from __future__ import annotations

import base64
import hashlib
import logging
import os
import re
import time
from typing import Callable

import httpx

import sarvam

logger = logging.getLogger("setu")

ProgressFn = Callable[[dict], None] | None

# Free multimodal models currently available on OpenRouter (Jul 2026).
# Prefer Gemma 4 26B — verified ~20s OCR on sample notice vs Sarvam Vision ~100s+.
DEFAULT_OPENROUTER_MODEL = "google/gemma-4-26b-a4b-it:free"
OPENROUTER_FALLBACK_MODELS = (
    "google/gemma-4-26b-a4b-it:free",
    "nvidia/nemotron-nano-12b-v2-vl:free",
    "openrouter/free",
)
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

_OCR_PROMPT = """Extract ALL readable text from this image for a voice assistant.

Rules:
- Transcribe every visible word, number, date, and heading in reading order.
- Preserve the original language/script (Hindi, Marathi, Telugu, English, etc.).
- Use plain text. Use blank lines between sections.
- If it is a document, notice, form, screenshot, or paper — extract the text, do not describe the scene.
- If almost no text is readable, reply with exactly: UNCLEAR_SCAN
- Do not invent text that is not visible.
"""


def resolve_ocr_provider() -> str:
    """OpenRouter-only OCR (Sarvam removed)."""
    has_or = bool((os.getenv("OPENROUTER_API_KEY") or "").strip())
    return "openrouter" if has_or else "none"


def _emit(progress: ProgressFn, event: dict) -> None:
    if progress:
        progress(event)


def _pdf_text_layer(file_bytes: bytes) -> str:
    """Instant path for digital PDFs — no vision call."""
    try:
        from pypdf import PdfReader

        reader = PdfReader(__import__("io").BytesIO(file_bytes))
        parts: list[str] = []
        for page in reader.pages:
            parts.append(page.extract_text() or "")
        return "\n".join(parts).strip()
    except Exception:
        logger.warning("PDF text-layer extract failed", exc_info=True)
        return ""


def _candidate_models() -> list[str]:
    preferred = (os.getenv("OPENROUTER_OCR_MODEL") or DEFAULT_OPENROUTER_MODEL).strip()
    ordered: list[str] = []
    for model in (preferred, *OPENROUTER_FALLBACK_MODELS):
        if model and model not in ordered:
            ordered.append(model)
    return ordered


def _openrouter_ocr_image(
    file_bytes: bytes,
    *,
    mime: str,
    language: str,
) -> tuple[str, str]:
    """Returns (text, model_id_used)."""
    api_key = (os.getenv("OPENROUTER_API_KEY") or "").strip()
    if not api_key:
        raise RuntimeError("OPENROUTER_API_KEY not set")

    lang_hint = (language or "en").split("-", 1)[0]
    data_url = f"data:{mime};base64,{base64.b64encode(file_bytes).decode('ascii')}"
    prompt = (
        f"{_OCR_PROMPT}\n"
        f"Preferred reading language hint: {lang_hint}. "
        f"Still extract every script you see."
    )
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": os.getenv("FRONTEND_ORIGIN") or "http://localhost:3000",
        "X-Title": "Setu",
    }

    last_error: Exception | None = None
    for model in _candidate_models():
        payload = {
            "model": model,
            "temperature": 0,
            "max_tokens": 1800,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {"type": "image_url", "image_url": {"url": data_url}},
                    ],
                }
            ],
        }
        t0 = time.perf_counter()
        try:
            with httpx.Client(timeout=httpx.Timeout(35.0, connect=8.0)) as client:
                response = client.post(OPENROUTER_URL, headers=headers, json=payload)
            body = response.json()
            if response.status_code == 429:
                last_error = RuntimeError(f"OpenRouter rate limited: {model}")
                logger.warning("[ocr] rate limited model=%s", model)
                continue
            if response.status_code >= 400:
                detail = str(body.get("error") or response.text)[:300]
                last_error = RuntimeError(f"OpenRouter OCR {response.status_code}: {detail}")
                logger.warning("[ocr] model=%s failed: %s", model, detail)
                continue

            content = (
                (((body.get("choices") or [{}])[0].get("message") or {}).get("content"))
                or ""
            )
            if isinstance(content, list):
                content = " ".join(
                    part.get("text", "") if isinstance(part, dict) else str(part)
                    for part in content
                )
            text = str(content).strip()
            used = str(body.get("model") or model)
            elapsed = time.perf_counter() - t0
            logger.info(
                "[ocr] openrouter model=%s chars=%s in %.2fs",
                used,
                len(text),
                elapsed,
            )
            if not text:
                last_error = RuntimeError(f"OpenRouter empty OCR from {used}")
                continue
            return text, used
        except Exception as exc:
            last_error = exc
            logger.warning("[ocr] model=%s error: %s", model, exc)
            continue

    raise RuntimeError(f"OpenRouter OCR failed: {last_error}")


def _mime_for_format(fmt: str) -> str:
    if fmt == "png":
        return "image/png"
    if fmt == "pdf":
        return "application/pdf"
    return "image/jpeg"


def extract_document(
    file_bytes: bytes,
    filename: str,
    language: str = "te-IN",
    progress: ProgressFn = None,
) -> dict:
    """Extract text; prefer OpenRouter free vision for camera images."""
    lang = language or "te-IN"
    file_hash = hashlib.sha256(file_bytes).hexdigest()
    doc_id = hashlib.sha256(f"{file_hash}:{lang}".encode()).hexdigest()

    hit = sarvam.get_document(doc_id)
    if hit:
        _emit(
            progress,
            {
                "type": "progress",
                "message": "Using saved document",
                "from_page": 1,
                "to_page": hit.get("pages", 1),
                "total_pages": hit.get("pages", 1),
            },
        )
        return {
            "doc_id": doc_id,
            "text": hit["text"],
            "pages": hit.get("pages", 1),
            "cached": True,
            "provider": hit.get("provider") or "cache",
            "preview": (hit["text"] or "")[:500],
        }

    actual = sarvam._detect_format(file_bytes)  # noqa: SLF001
    if actual not in {"pdf", "png", "jpeg"}:
        raise ValueError("Unsupported file format; accepts PDF, PNG, JPG")

    provider = resolve_ocr_provider()
    _emit(
        progress,
        {
            "type": "progress",
            "message": "Reading document",
            "from_page": 1,
            "to_page": 1,
            "total_pages": 1,
            "provider": provider,
        },
    )

    text = ""
    pages = 1
    used = provider
    model_used: str | None = None

    # Digital PDF text layer — usually <100ms.
    if actual == "pdf":
        layer = _pdf_text_layer(file_bytes)
        if len(re.sub(r"\s+", "", layer)) >= 80:
            text = layer
            try:
                pages = max(1, sarvam._pdf_page_count(file_bytes))  # noqa: SLF001
            except Exception:
                pages = 1
            used = "pdf-text"
            logger.info("[ocr] pdf text-layer pages=%s chars=%s", pages, len(text))

    if not text and actual in {"png", "jpeg"}:
        if not (os.getenv("OPENROUTER_API_KEY") or "").strip():
            raise RuntimeError("OPENROUTER_API_KEY required for document OCR")
        text, model_used = _openrouter_ocr_image(
            file_bytes,
            mime=_mime_for_format(actual),
            language=lang,
        )
        used = "openrouter"
    elif not text and actual == "pdf":
        raise RuntimeError(
            "This PDF has no extractable text layer. Export pages as JPG/PNG and scan again."
        )

    unclear = text.strip().upper() == "UNCLEAR_SCAN" or sarvam._is_unclear(text)  # noqa: SLF001
    if unclear:
        return {
            "doc_id": doc_id,
            "text": text,
            "pages": pages,
            "cached": False,
            "status": "unclear_scan",
            "provider": used,
            "model": model_used,
            "preview": (text or "")[:500],
        }

    entry = {
        "doc_id": doc_id,
        "text": text,
        "pages": pages,
        "provider": used,
        "model": model_used,
    }
    sarvam._set_cached_document(doc_id, entry)  # noqa: SLF001
    return {
        **entry,
        "cached": False,
        "preview": text[:500],
    }
