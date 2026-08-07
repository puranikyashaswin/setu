from __future__ import annotations

import asyncio
import unittest
from collections.abc import AsyncIterator

from backend.app.llm.context_manager import build_context
from backend.app.llm.policy import policy_for
from backend.app.shared.protocol import VoiceEvent
from backend.app.voice.pipeline import PipelineTimeouts, PushToTalkPipeline, TranscriptUpdate
from backend.app.voice.turn_manager import VoiceSession


async def audio_chunks() -> AsyncIterator[bytes]:
    yield b"pcm"


class FakeStt:
    async def transcribe(self, audio, *, language: str):
        async for _ in audio:
            yield TranscriptUpdate("namaste", final=False)
            yield TranscriptUpdate("namaste", final=True)


class HangingStt:
    async def transcribe(self, audio, *, language: str):
        await asyncio.sleep(1)
        if False:
            yield TranscriptUpdate("", final=True)


class FakeLlm:
    async def stream(self, messages, *, language: str, policy):
        yield "Hello"
        yield " there"


class HangingLlm:
    async def stream(self, messages, *, language: str, policy):
        await asyncio.sleep(1)
        if False:
            yield ""


class FakeTts:
    async def stream(self, text: str, *, language: str):
        yield b"audio-1"
        yield b"audio-2"


class HangingTts:
    async def stream(self, text: str, *, language: str):
        yield b"audio-1"
        await asyncio.sleep(1)


class VoicePipelineTests(unittest.IsolatedAsyncioTestCase):
    async def test_streams_partial_transcript_text_and_audio_without_audio_json(self) -> None:
        session = VoiceSession.new("user-1", session_id="session-1")
        session.transition("CONNECTING")
        session.transition("READY")
        events: list[VoiceEvent] = []
        audio: list[bytes] = []
        timings: list[str] = []

        async def emit(event: VoiceEvent) -> None:
            events.append(event)

        async def sink(chunk: bytes) -> None:
            audio.append(chunk)

        pipeline = PushToTalkPipeline(
            session=session,
            stt=FakeStt(),
            llm=FakeLlm(),
            tts=FakeTts(),
            emit=emit,
            audio_sink=sink,
            on_timing=timings.append,
        )
        await pipeline.run(audio_chunks(), turn=session.begin_turn("turn-1"))
        self.assertEqual(session.state, "LISTENING")
        self.assertEqual(audio, [b"audio-1", b"audio-2"])
        self.assertEqual([event.type for event in events], [
            "transcript.partial",
            "transcript.final",
            "assistant.text.delta",
            "assistant.text.delta",
            "assistant.audio.started",
            "assistant.audio.chunk",
            "assistant.audio.chunk",
            "assistant.audio.finished",
        ])
        self.assertNotIn("audio_base64", events[-1].model_dump())
        self.assertEqual(
            timings,
            ["stt_partial", "stt_final", "llm_first_token", "tts_requested", "tts_first_chunk", "audio_finished"],
        )

    async def test_barge_in_cancels_tts_and_emits_cancelled_event(self) -> None:
        session = VoiceSession.new("user-1", session_id="session-1")
        session.transition("CONNECTING")
        session.transition("READY")
        events: list[VoiceEvent] = []

        async def emit(event: VoiceEvent) -> None:
            events.append(event)

        pipeline = PushToTalkPipeline(
            session=session,
            stt=FakeStt(),
            llm=FakeLlm(),
            tts=HangingTts(),
            emit=emit,
        )
        task = asyncio.create_task(pipeline.run(audio_chunks(), turn=session.begin_turn("turn-1")))
        for _ in range(20):
            if session.state == "SPEAKING":
                break
            await asyncio.sleep(0.01)
        session.barge_in("speech_detected")
        task.cancel()
        await task
        self.assertEqual(session.state, "LISTENING")
        self.assertEqual([event.type for event in events][-1], "turn.cancelled")

    async def test_stt_timeout_fails_only_the_active_turn(self) -> None:
        session = VoiceSession.new("user-1", session_id="session-1")
        session.transition("CONNECTING")
        session.transition("READY")
        events: list[VoiceEvent] = []

        async def emit(event: VoiceEvent) -> None:
            events.append(event)

        pipeline = PushToTalkPipeline(
            session=session,
            stt=HangingStt(),
            llm=FakeLlm(),
            tts=FakeTts(),
            emit=emit,
            timeouts=PipelineTimeouts(stt_seconds=0.01, llm_seconds=0.01, tts_seconds=0.01),
        )
        await pipeline.run(audio_chunks(), turn=session.begin_turn("turn-1"))
        self.assertEqual(session.state, "ERROR")
        self.assertEqual(events[-1].type, "error")


class ContextAndPolicyTests(unittest.TestCase):
    def test_document_context_is_bounded_and_policy_is_explicit(self) -> None:
        context = build_context(
            [{"role": "user", "content": "hello"}] * 20,
            document_chunks=["x" * 2_000] * 10,
            include_document=True,
        )
        self.assertLessEqual(len(context.messages), 8)
        self.assertLessEqual(len(context.document_chunks), 4)
        self.assertTrue(all(len(chunk) <= 900 for chunk in context.document_chunks))
        self.assertEqual(policy_for(task="simple_chat").reasoning_effort, "none")
        self.assertEqual(policy_for(task="document_question").reasoning_effort, "low")
