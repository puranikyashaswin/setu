"""LiveKit Agents entrypoint for the first native push-to-talk slice.

The worker owns provider credentials and publishes only versioned control
events. User and assistant audio stays on the LiveKit media tracks.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from dataclasses import dataclass
import logging
from typing import Any, Callable

from backend.app.llm.sarvam_streaming import SarvamRealtimeStt, SarvamStreamingLlm, SarvamStreamingTts
from backend.app.realtime.audio import normalize_pcm16_mono
from backend.app.realtime.livekit import LiveKitConfig
from backend.app.shared.protocol import ErrorEvent, SessionReadyEvent, VoiceEvent
from backend.app.voice.control import ControlEnvelope, TurnCancel, TurnStart, TurnStop, assert_session_scope, parse_control_message
from backend.app.voice.pipeline import PushToTalkPipeline
from backend.app.voice.telemetry import TurnTrace
from backend.app.voice.turn_manager import VoiceSession

CONTROL_TOPIC = "setu-control-v1"
OUTPUT_SAMPLE_RATE = 22_050
INPUT_SAMPLE_RATE = 16_000
logger = logging.getLogger(__name__)


class AudioInput:
    """Closable async byte stream used to delimit one push-to-talk turn."""

    def __init__(self) -> None:
        self._queue: asyncio.Queue[bytes | None] = asyncio.Queue()

    async def put(self, chunk: bytes) -> None:
        await self._queue.put(chunk)

    async def close(self) -> None:
        await self._queue.put(None)

    def __aiter__(self) -> AsyncIterator[bytes]:
        return self._iterate()

    async def _iterate(self) -> AsyncIterator[bytes]:
        while True:
            chunk = await self._queue.get()
            if chunk is None:
                return
            yield chunk


@dataclass
class PcmAudioSink:
    """Converts arbitrary Sarvam PCM chunks into LiveKit audio frames."""

    source: Any
    audio_byte_stream: Any
    on_frame: Callable[[], None] | None = None

    async def push(self, data: bytes) -> None:
        for frame in self.audio_byte_stream.push(data):
            if self.on_frame:
                self.on_frame()
            await self.source.capture_frame(frame)

    def clear(self) -> None:
        self.audio_byte_stream = self.audio_byte_stream.__class__(
            sample_rate=OUTPUT_SAMPLE_RATE,
            num_channels=1,
            samples_per_channel=OUTPUT_SAMPLE_RATE // 20,
        )
        clear_queue = getattr(self.source, "clear_queue", None)
        if callable(clear_queue):
            clear_queue()


def _participant_metadata(participant: Any) -> dict[str, str]:
    try:
        value = json.loads(participant.metadata or "{}")
    except (TypeError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def _event_payload(event: VoiceEvent) -> str:
    return json.dumps(event.model_dump(by_alias=True), separators=(",", ":"))


def run_worker() -> None:
    """Start the LiveKit worker; imports the optional runtime lazily for tests."""

    try:
        from livekit import agents, rtc
        from livekit.agents import AgentServer
        from livekit.agents.utils.audio import AudioByteStream
    except ImportError as exc:  # pragma: no cover - deployment-only dependency
        raise RuntimeError("Install livekit-agents and livekit-api to run the voice worker") from exc

    config = LiveKitConfig.from_environment()
    server = AgentServer()

    @server.rtc_session(agent_name=config.agent_name)
    async def setu_voice(ctx: agents.JobContext) -> None:
        await ctx.connect(auto_subscribe=agents.AutoSubscribe.AUDIO_ONLY)
        participant = await ctx.wait_for_participant()
        metadata = _participant_metadata(participant)
        session_id = metadata.get("session_id", "")
        language = metadata.get("language", "en")
        if not session_id:
            await ctx.room.local_participant.publish_data(
                _event_payload(ErrorEvent(session_id="invalid", turn_id="session", code="session_scope", message="Voice session metadata is missing.")),
                reliable=True,
                destination_identities=[participant.identity],
                topic=CONTROL_TOPIC,
            )
            return

        session = VoiceSession.new(user_id=participant.identity, session_id=session_id, language=language)
        session.transition("CONNECTING")
        session.transition("READY")
        output_source = rtc.AudioSource(OUTPUT_SAMPLE_RATE, 1)
        output_track = rtc.LocalAudioTrack.create_audio_track("setu-assistant", output_source)
        await ctx.room.local_participant.publish_track(
            output_track,
            rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE),
        )
        audio_sink = PcmAudioSink(
            output_source,
            AudioByteStream(sample_rate=OUTPUT_SAMPLE_RATE, num_channels=1, samples_per_channel=OUTPUT_SAMPLE_RATE // 20),
        )
        active_input: AudioInput | None = None
        active_task: asyncio.Task[None] | None = None
        current_trace: TurnTrace | None = None

        def mark_published_audio() -> None:
            if current_trace:
                current_trace.mark("assistant_first_audio_published")

        audio_sink.on_frame = mark_published_audio

        async def emit(event: VoiceEvent) -> None:
            await ctx.room.local_participant.publish_data(
                _event_payload(event),
                reliable=True,
                destination_identities=[participant.identity],
                topic=CONTROL_TOPIC,
            )

        async def finish_task(task: asyncio.Task[None]) -> None:
            try:
                await task
            except asyncio.CancelledError:
                pass

        async def start_turn(command: TurnStart) -> None:
            nonlocal active_input, active_task, current_trace
            assert_session_scope(command, session_id)
            if active_task and not active_task.done():
                await emit(ErrorEvent(session_id=session_id, turn_id=command.turn_id, code="turn_in_progress", message="The previous voice turn is still active."))
                return
            active_input = AudioInput()
            turn = session.begin_turn(command.turn_id)
            current_trace = TurnTrace(command.turn_id)
            current_trace.mark("mic_ready")
            trace = current_trace
            pipeline = PushToTalkPipeline(
                session=session,
                stt=SarvamRealtimeStt(),
                llm=SarvamStreamingLlm(),
                tts=SarvamStreamingTts(),
                emit=emit,
                audio_sink=audio_sink.push,
                on_timing=trace.mark,
            )
            current_input = active_input

            async def run_turn() -> None:
                try:
                    await pipeline.run(current_input, turn=turn)
                finally:
                    logger.info("voice.turn %s", json.dumps(trace.snapshot(), sort_keys=True))
                    if active_input is current_input:
                        # The next turn gets a fresh delimiter and cannot reuse
                        # audio that was queued for an older turn.
                        pass

            active_task = asyncio.create_task(run_turn())

        async def stop_turn(command: TurnStop) -> None:
            assert_session_scope(command, session_id)
            if session.active_turn and session.active_turn.turn_id == command.turn_id and active_input:
                await active_input.close()

        async def cancel_turn(command: TurnCancel) -> None:
            assert_session_scope(command, session_id)
            if session.active_turn and session.active_turn.turn_id == command.turn_id:
                if current_trace:
                    current_trace.mark("barge_in")
                audio_sink.clear()
                if current_trace:
                    current_trace.mark("audio_stopped")
                session.barge_in(command.reason)
                if active_input:
                    await active_input.close()
                if active_task and not active_task.done():
                    active_task.cancel()

        async def handle_control(packet: Any) -> None:
            if packet.participant is None or packet.participant.identity != participant.identity:
                return
            try:
                command: ControlEnvelope = parse_control_message(packet.data)
                if isinstance(command, TurnStart):
                    await start_turn(command)
                elif isinstance(command, TurnStop):
                    await stop_turn(command)
                elif isinstance(command, TurnCancel):
                    await cancel_turn(command)
            except Exception:
                turn_id = getattr(command, "turn_id", "session") if "command" in locals() else "session"
                await emit(ErrorEvent(session_id=session_id, turn_id=turn_id, code="invalid_control", message="Invalid voice control message."))

        @ctx.room.on("data_received")
        def on_data_received(packet: Any) -> None:
            if packet.topic == CONTROL_TOPIC:
                asyncio.create_task(handle_control(packet))

        async def consume_track(track: Any) -> None:
            stream = rtc.AudioStream(track, sample_rate=INPUT_SAMPLE_RATE, num_channels=1, frame_size_ms=20)
            try:
                async for event in stream:
                    if active_input is not None:
                        if current_trace:
                            current_trace.mark("mic_audio_first_frame")
                        frame = event.frame
                        await active_input.put(
                            normalize_pcm16_mono(
                                bytes(frame.data),
                                sample_rate=int(getattr(frame, "sample_rate", INPUT_SAMPLE_RATE)),
                                channels=int(getattr(frame, "num_channels", 1)),
                                target_sample_rate=INPUT_SAMPLE_RATE,
                            )
                        )
            finally:
                await stream.aclose()

        @ctx.room.on("track_subscribed")
        def on_track_subscribed(track: Any, *_: Any) -> None:
            if track.kind == rtc.TrackKind.KIND_AUDIO:
                asyncio.create_task(consume_track(track))

        await emit(SessionReadyEvent(session_id=session_id, turn_id="session"))
        shutdown_event = asyncio.Event()

        async def mark_shutdown() -> None:
            shutdown_event.set()

        ctx.add_shutdown_callback(mark_shutdown)
        await shutdown_event.wait()
        if active_input:
            await active_input.close()
        if active_task and not active_task.done():
            active_task.cancel()
            await finish_task(active_task)
        await output_source.aclose()

    agents.cli.run_app(server)


def main() -> None:
    run_worker()


if __name__ == "__main__":  # pragma: no cover
    main()
