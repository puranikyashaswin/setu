"""Document OCR — Sarvam Document Intelligence (Vision) only."""

from __future__ import annotations

import hashlib
import logging
import re
import time
from typing import Callable

import sarvam

logger = logging.getLogger("setu")

ProgressFn = Callable[[dict], None] | None


def resolve_ocr_provider() -> str:
    """OCR is Sarvam Vision only."""
    return "sarvam"


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


def extract_document(
    file_bytes: bytes,
    filename: str,
    language: str = "te-IN",
    progress: ProgressFn = None,
) -> dict:
    """Extract text via Sarvam Vision (or PDF text layer when available)."""
    lang = language or "te-IN"
    file_hash = hashlib.sha256(file_bytes).hexdigest()
    doc_id = hashlib.sha256(f"{file_hash}:{lang}".encode()).hexdigest()
    t0 = time.perf_counter()

    _emit(
        progress,
        {"type": "progress", "stage": "upload_received", "percent": 5, "message": "Upload received"},
    )

    hit = sarvam.get_document(doc_id)
    if hit:
        _emit(
            progress,
            {
                "type": "progress",
                "stage": "ocr_started",
                "percent": 20,
                "message": "Using saved document",
                "from_page": 1,
                "to_page": hit.get("pages", 1),
                "total_pages": hit.get("pages", 1),
            },
        )
        logger.info(
            "[ocr] doc_id=%s status=done total_ms=%s polls=0 pages=%s",
            doc_id[:12],
            int((time.perf_counter() - t0) * 1000),
            hit.get("pages") or 0,
        )
        return {
            "doc_id": doc_id,
            "text": hit["text"],
            "pages": hit.get("pages", 1),
            "cached": True,
            "status": "done",
            "provider": hit.get("provider") or "cache",
            "preview": (hit["text"] or "")[:500],
        }

    actual = sarvam._detect_format(file_bytes)  # noqa: SLF001
    if actual not in {"pdf", "png", "jpeg"}:
        raise ValueError("Unsupported file format; accepts PDF, PNG, JPG")

    # Digital PDF text layer — usually <100ms; skips Vision.
    if actual == "pdf":
        layer = _pdf_text_layer(file_bytes)
        if len(re.sub(r"\s+", "", layer)) >= 80:
            try:
                pages = max(1, sarvam._pdf_page_count(file_bytes))  # noqa: SLF001
            except Exception:
                pages = 1
            unclear = sarvam._is_unclear(layer)  # noqa: SLF001
            status = "unclear_scan" if unclear else "done"
            if not unclear:
                sarvam._set_cached_document(  # noqa: SLF001
                    doc_id,
                    {"doc_id": doc_id, "text": layer, "pages": pages, "provider": "pdf-text"},
                )
            logger.info(
                "[ocr] doc_id=%s status=done total_ms=%s polls=0 pages=%s",
                doc_id[:12],
                int((time.perf_counter() - t0) * 1000),
                pages,
            )
            return {
                "doc_id": doc_id,
                "text": layer,
                "pages": pages,
                "cached": False,
                "status": status,
                "provider": "pdf-text",
                "preview": layer[:500],
            }

    _emit(
        progress,
        {
            "type": "progress",
            "stage": "ocr_started",
            "percent": 20,
            "message": "Reading document",
            "provider": "sarvam",
        },
    )

    # Sarvam extract_document already emits the single finish [ocr] log.
    result = sarvam.extract_document(
        file_bytes,
        filename,
        language=lang,
        progress=progress,
    )
    result = {
        **result,
        "provider": result.get("provider") or "sarvam",
        "preview": (result.get("preview") or (result.get("text") or "")[:500]),
    }
    return result
