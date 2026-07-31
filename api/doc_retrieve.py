"""Lightweight document chunk retrieval — no vector DB required for demos."""

from __future__ import annotations

import re
from dataclasses import dataclass


_TOKEN_RE = re.compile(r"[\w\u0900-\u097F\u0C00-\u0C7F\u0B80-\u0BFF\u0C80-\u0CFF\u0A80-\u0AFF\u0980-\u09FF\u0D00-\u0D7F\u0A00-\u0A7F\u0B00-\u0B7F]+", re.UNICODE)


@dataclass
class DocChunk:
    index: int
    text: str
    start: int
    end: int


def chunk_document(text: str, *, chunk_chars: int = 900, overlap: int = 120) -> list[DocChunk]:
    raw = (text or "").strip()
    if not raw:
        return []
    if len(raw) <= chunk_chars:
        return [DocChunk(index=0, text=raw, start=0, end=len(raw))]

    chunks: list[DocChunk] = []
    start = 0
    index = 0
    while start < len(raw):
        end = min(len(raw), start + chunk_chars)
        if end < len(raw):
            # Prefer breaking on paragraph / sentence boundaries.
            window = raw[start:end]
            break_at = max(window.rfind("\n\n"), window.rfind("\n"), window.rfind(". "), window.rfind("। "))
            if break_at >= int(chunk_chars * 0.45):
                end = start + break_at + 1
        piece = raw[start:end].strip()
        if piece:
            chunks.append(DocChunk(index=index, text=piece, start=start, end=end))
            index += 1
        if end >= len(raw):
            break
        start = max(0, end - overlap)
    return chunks


def _tokens(text: str) -> set[str]:
    return {m.group(0).lower() for m in _TOKEN_RE.finditer(text or "") if len(m.group(0)) > 1}


def retrieve_chunks(
    doc_text: str,
    question: str,
    *,
    max_chars: int = 4500,
    max_chunks: int = 6,
) -> str:
    """Return the most relevant document excerpts for a question."""
    chunks = chunk_document(doc_text)
    if not chunks:
        return ""
    if len(chunks) == 1 or len(doc_text) <= max_chars:
        return doc_text[:max_chars]

    q_tokens = _tokens(question)
    if not q_tokens:
        return doc_text[:max_chars]

    scored: list[tuple[float, DocChunk]] = []
    for chunk in chunks:
        c_tokens = _tokens(chunk.text)
        if not c_tokens:
            continue
        overlap = len(q_tokens & c_tokens)
        # Prefer denser overlap and slightly earlier chunks (titles/headers).
        score = overlap + (0.15 * overlap / max(1, len(c_tokens))) - (chunk.index * 0.01)
        scored.append((score, chunk))

    scored.sort(key=lambda item: item[0], reverse=True)
    picked = [item[1] for item in scored[:max_chunks] if item[0] > 0]
    if not picked:
        return doc_text[:max_chars]

    # Restore document order for readable context.
    picked.sort(key=lambda c: c.index)
    parts: list[str] = []
    total = 0
    for chunk in picked:
        block = f"[Excerpt {chunk.index + 1}]\n{chunk.text}"
        if total + len(block) > max_chars and parts:
            break
        parts.append(block)
        total += len(block) + 2
    return "\n\n".join(parts)[:max_chars]
