"""Cancellable server-owned voice turn orchestration.

Provider calls are injected so the worker can be tested without network access
and the existing ``api/sarvam.py`` implementation can migrate in stages.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Protocol

from backend.app.llm.context_manager import ContextWindow, build_context
from backend.app.llm.policy import ModelPolicy, policy_for
from backend.app.shared.protocol import VoiceEvent
from backend.app.voice.turn_manager import ActiveTurn, VoiceSession


class SttProvider(Protocol):
    async def transcribe(self, audio: bytes, *, language: str) -> str: ...


class LlmProvider(Protocol):
    async def stream(self, prompt: ContextWindow, *, policy: ModelPolicy):
        """Yield visible text deltas only; never expose reasoning content."""


class TtsProvider(Protocol):
    async def stream(self, text: str, *, language: str): ...


@dataclass
class VoiceAgentSession:
    session: VoiceSession
    stt: SttProvider
    llm: LlmProvider
    tts: TtsProvider
    emit: Callable[[VoiceEvent], Awaitable[None]]
    history: list[dict[str, str]] = field(default_factory=list)
    rolling_summary: str | None = None
    document_chunks: list[str] = field(default_factory=list)

    async def handle_audio_turn(self, audio: bytes) -> None:
        """Run one turn and cancel every child stage on barge-in."""

        turn = self.session.active_turn or self.session.begin_turn()
        try:
            transcript = await self._cancellable(self.stt.transcribe(audio, language=self.session.language), turn)
            if not transcript:
                return
            self.session.endpoint()
            await self._answer(turn, transcript)
        except asyncio.CancelledError:
            raise
        finally:
            if self.session.active_turn is turn and turn.cancel_event.is_set():
                self.session.finish_turn()

    async def barge_in(self, reason: str = "speech_detected") -> None:
        """Set cancellation before any remote cancel acknowledgement is awaited."""

        self.session.barge_in(reason)

    async def _answer(self, turn: ActiveTurn, transcript: str) -> None:
        self.session.start_thinking()
        self.history.append({"role": "user", "content": transcript})
        context = build_context(
            self.history,
            rolling_summary=self.rolling_summary,
            document_chunks=self.document_chunks,
            include_document=bool(self.document_chunks),
        )
        policy = policy_for(task="document_question" if self.document_chunks else "simple_chat")
        answer_parts: list[str] = []
        async for delta in self.llm.stream(context, policy=policy):
            self._raise_if_cancelled(turn)
            answer_parts.append(delta)
            # A production implementation emits assistant.text.delta here and
            # sends phrase-safe chunks to TTS; no internal reasoning is emitted.
        answer = "".join(answer_parts).strip()
        if not answer:
            return
        self.session.start_speaking()
        async for _audio_chunk in self.tts.stream(answer, language=self.session.language):
            self._raise_if_cancelled(turn)
        self.history.append({"role": "assistant", "content": answer})
        self.session.finish_turn()

    async def _cancellable(self, awaitable, turn: ActiveTurn):
        task = asyncio.create_task(awaitable)
        cancel_waiter = asyncio.create_task(turn.cancel_event.wait())
        done, pending = await asyncio.wait({task, cancel_waiter}, return_when=asyncio.FIRST_COMPLETED)
        for item in pending:
            item.cancel()
        if cancel_waiter in done and turn.cancel_event.is_set():
            task.cancel()
            raise asyncio.CancelledError
        return task.result()

    @staticmethod
    def _raise_if_cancelled(turn: ActiveTurn) -> None:
        if turn.cancel_event.is_set():
            raise asyncio.CancelledError
