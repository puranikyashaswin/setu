"""Bounded context assembly for voice turns."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ContextWindow:
    messages: list[dict[str, str]]
    document_chunks: list[str]
    rolling_summary: str | None


def build_context(
    history: list[dict[str, str]],
    *,
    rolling_summary: str | None = None,
    document_chunks: list[str] | None = None,
    include_document: bool = False,
    max_turns: int = 8,
    max_chunk_chars: int = 900,
) -> ContextWindow:
    """Keep recent turns in full and include OCR only for document intents."""

    recent = [
        {"role": item["role"], "content": item["content"]}
        for item in history[-max_turns:]
        if item.get("role") in {"user", "assistant"} and item.get("content")
    ]
    chunks = []
    if include_document:
        chunks = [chunk[:max_chunk_chars] for chunk in (document_chunks or [])[:4] if chunk.strip()]
    return ContextWindow(messages=recent, document_chunks=chunks, rolling_summary=rolling_summary)
