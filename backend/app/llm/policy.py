"""Conservative Sarvam-105B policy for low-latency spoken responses."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

ReasoningEffort = Literal["none", "low", "medium"]


@dataclass(frozen=True)
class ModelPolicy:
    reasoning_effort: ReasoningEffort
    response_mode: Literal["spoken", "text_first"]
    max_output_tokens: int


def policy_for(*, task: str, has_document: bool = False) -> ModelPolicy:
    normalized = task.strip().lower()
    if normalized in {"greeting", "small_talk", "simple_chat"}:
        return ModelPolicy("none", "spoken", 180)
    if normalized in {"ocr_clarification", "document_summary"}:
        return ModelPolicy("none", "spoken", 220)
    if normalized in {"document_question", "multistep_document_question"}:
        effort: ReasoningEffort = "low" if normalized != "multistep_document_question" else "low"
        return ModelPolicy(effort, "spoken", 260)
    if normalized in {"tool_action", "action_request"}:
        return ModelPolicy("low", "spoken", 260)
    if normalized in {"complex_analysis", "coding", "planning"}:
        return ModelPolicy("medium", "text_first", 900)
    return ModelPolicy("none", "spoken", 220)
