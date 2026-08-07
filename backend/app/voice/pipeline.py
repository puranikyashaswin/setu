"""Push-to-talk STT -> LLM -> TTS pipeline with cancellation and deadlines."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterable, AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from typing import Protocol

from backend.app.llm.context_manager import build_context
from backend.app.llm.policy import policy_for
from backend.app.shared.protocol import (
    AssistantAudioChunkEvent,
    AssistantAudioFinishedEvent,
    AssistantAudioStartedEvent,
    AssistantTextDeltaEvent,
    ErrorEvent,
    TranscriptFinalEvent,
    TranscriptPartialEvent,
    TurnCancelledEvent,
    VoiceEvent,
)
from backend.app.voice.turn_manager import ActiveTurn, VoiceSession


@dataclass(frozen=True)
class TranscriptUpdate:
    text: str
    final: bool = False


class StreamingStt(Protocol):
    def transcribe(self, audio: AsyncIterable[bytes], *, language: str) -> AsyncIterator[TranscriptUpdate]: ...


class StreamingLlm(Protocol):
    def stream(self, messages: list[dict[str, str]], *, language: str, policy): ...


class StreamingTts(Protocol):
    def stream(self, text: str, *, language: str) -> AsyncIterator[bytes]: ...


@dataclass(frozen=True)
class PipelineTimeouts:
    stt_seconds: float = 12.0
    llm_seconds: float = 12.0
    tts_seconds: float = 12.0


@dataclass
class PushToTalkPipeline:
    session: VoiceSession
    stt: StreamingStt
    llm: StreamingLlm
    tts: StreamingTts
    emit: Callable[[VoiceEvent], Awaitable[None]]
    audio_sink: Callable[[bytes], Awaitable[None]] | None = None
    timeouts: PipelineTimeouts = field(default_factory=PipelineTimeouts)
    history: list[dict[str, str]] = field(default_factory=list)
    rolling_summary: str | None = None
    document_chunks: list[str] = field(default_factory=list)
    on_timing: Callable[[str], None] | None = None

    async def run(self, audio: AsyncIterable[bytes], *, turn: ActiveTurn | None = None) -> None:
        active = turn or self.session.active_turn or self.session.begin_turn()
        try:
            transcript = await self._run_stt(audio, active)
            if not transcript:
                return
            self.session.endpoint()
            self.session.start_thinking()
            self.history.append({"role": "user", "content": transcript})
            context = build_context(
                self.history,
                rolling_summary=self.rolling_summary,
                document_chunks=self.document_chunks,
                include_document=bool(self.document_chunks),
            )
            policy = policy_for(task="document_question" if self.document_chunks else "simple_chat")
            messages = list(context.messages)
            if context.rolling_summary:
                messages.insert(0, {"role": "system", "content": context.rolling_summary})
            if context.document_chunks:
                messages.insert(0, {"role": "system", "content": "Document context:\n" + "\n".join(context.document_chunks)})

            answer_parts: list[str] = []
            llm_token_seen = False
            async with asyncio.timeout(self.timeouts.llm_seconds):
                async for delta in self.llm.stream(messages, language=self.session.language, policy=policy):
                    self._raise_if_cancelled(active)
                    if not delta:
                        continue
                    if not llm_token_seen:
                        self._mark("llm_first_token")
                        llm_token_seen = True
                    answer_parts.append(delta)
                    await self.emit(AssistantTextDeltaEvent(session_id=self.session.session_id, turn_id=active.turn_id, text=delta))
            answer = "".join(answer_parts).strip()
            if not answer:
                raise RuntimeError("empty_llm_response")
            self.session.start_speaking()
            self._mark("tts_requested")
            await self.emit(AssistantAudioStartedEvent(session_id=self.session.session_id, turn_id=active.turn_id))
            sequence = 0
            tts_chunk_seen = False
            async with asyncio.timeout(self.timeouts.tts_seconds):
                async for chunk in self.tts.stream(answer, language=self.session.language):
                    self._raise_if_cancelled(active)
                    if not chunk:
                        continue
                    if not tts_chunk_seen:
                        self._mark("tts_first_chunk")
                        tts_chunk_seen = True
                    if self.audio_sink:
                        await self.audio_sink(chunk)
                    sequence += 1
                    await self.emit(AssistantAudioChunkEvent(session_id=self.session.session_id, turn_id=active.turn_id, sequence=sequence))
            await self.emit(AssistantAudioFinishedEvent(session_id=self.session.session_id, turn_id=active.turn_id))
            self._mark("audio_finished")
            self.history.append({"role": "assistant", "content": answer})
            self.session.finish_turn()
        except asyncio.CancelledError:
            await self._cancelled(active, "barge_in")
        except Exception as exc:
            if active.cancel_event.is_set() or self.session.state == "INTERRUPTED":
                await self._cancelled(active, "barge_in")
                return
            self.session.fail_turn()
            await self.emit(ErrorEvent(session_id=self.session.session_id, turn_id=active.turn_id, code="provider_failure", message="Voice provider failed; please try again."))

    async def _run_stt(self, audio: AsyncIterable[bytes], active: ActiveTurn) -> str:
        final = ""
        async with asyncio.timeout(self.timeouts.stt_seconds):
            async for update in self.stt.transcribe(audio, language=self.session.language):
                self._raise_if_cancelled(active)
                if not update.text:
                    continue
                if update.final:
                    final = update.text
                    self._mark("stt_final")
                    await self.emit(TranscriptFinalEvent(session_id=self.session.session_id, turn_id=active.turn_id, text=update.text))
                    break
                self._mark("stt_partial")
                await self.emit(TranscriptPartialEvent(session_id=self.session.session_id, turn_id=active.turn_id, text=update.text))
        return final.strip()

    async def _cancelled(self, active: ActiveTurn, reason: str) -> None:
        if self.session.active_turn is active:
            self._mark("turn_cancelled")
            if self.session.state != "INTERRUPTED":
                self.session.barge_in(reason)
            await self.emit(TurnCancelledEvent(session_id=self.session.session_id, turn_id=active.turn_id, reason=reason))
            self.session.finish_turn()

    @staticmethod
    def _raise_if_cancelled(active: ActiveTurn) -> None:
        if active.cancel_event.is_set():
            raise asyncio.CancelledError

    def _mark(self, name: str) -> None:
        if self.on_timing:
            self.on_timing(name)
