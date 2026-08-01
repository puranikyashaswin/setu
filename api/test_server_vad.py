"""Unit tests for server_vad_v1: engine selection + ServerVoiceTurn state machine."""

from __future__ import annotations

import unittest

import server_vad
from server_vad import (
    FRAME_BYTES,
    FRAME_MS,
    ServerVoiceTurn,
    WebRtcVadEngine,
)


class ArrayEngine:
    """Deterministic scripted VAD engine — one decision per frame."""

    name = "scripted"

    def __init__(self):
        self.decisions: list[bool] = []
        self.calls = 0

    def push(self, speech: bool, frames: int) -> None:
        self.decisions.extend([speech] * frames)

    def is_speech(self, frame: bytes) -> bool:
        decision = self.decisions[min(self.calls, len(self.decisions) - 1)] if self.decisions else False
        self.calls += 1
        return decision


def feed(turn: ServerVoiceTurn, frames: int, start_index: int = 0) -> None:
    for i in range(start_index, start_index + frames):
        turn.accept_frame(b"\x00" * FRAME_BYTES, i * FRAME_MS)


class StateMachineTests(unittest.TestCase):
    def setUp(self):
        self.engine = ArrayEngine()
        self.turn = ServerVoiceTurn(turn_id=1, engine=self.engine, voice_session_id="sess-1")

    def drain(self):
        return self.turn.drain_events()

    def test_speech_start_requires_240ms_voiced(self):
        self.engine.push(True, 11)  # 220ms
        feed(self.turn, 11)
        self.assertEqual(self.drain(), [])
        self.assertEqual(self.turn.state, server_vad.STATE_IDLE)
        self.engine.push(True, 1)
        feed(self.turn, 1, 11)
        events = self.drain()
        self.assertEqual(events[0]["type"], "vad_speech_start")
        self.assertEqual(events[0]["turn_id"], 1)
        self.assertEqual(events[0]["voice_session_id"], "sess-1")
        self.assertEqual(self.turn.state, server_vad.STATE_RECEIVING)

    def test_silence_800ms_endpoints_with_vad_silence_and_timing_fields(self):
        self.engine.push(True, 50)
        self.engine.push(False, 39)
        feed(self.turn, 89)
        self.assertEqual(self.turn.state, server_vad.STATE_RECEIVING)
        self.engine.push(False, 1)
        feed(self.turn, 1, 89)
        events = self.drain()
        types = [e["type"] for e in events]
        self.assertIn("vad_speech_start", types)
        self.assertIn("vad_speech_end_candidate", types)
        self.assertEqual(types[-1], "turn_finalized")
        final = events[-1]
        self.assertEqual(final["turn_finalize_reason"], "vad_silence")
        self.assertIsNotNone(final["first_audio_ms"])
        self.assertIsNotNone(final["speech_start_ms"])
        self.assertIsNotNone(final["turn_finalized_ms"])
        self.assertIsNotNone(final["finalize_latency_ms"])
        self.assertGreaterEqual(final["finalize_latency_ms"], 800 - FRAME_MS)
        seqs = [e["sequence"] for e in events]
        self.assertEqual(seqs, sorted(seqs))

    def test_prefix_and_trailing_padding_in_utterance_wav(self):
        self.engine.push(True, 50)  # 1000ms speech from frame 0
        self.engine.push(False, 40)
        feed(self.turn, 90)
        self.assertEqual(self.turn.state, server_vad.STATE_FINALIZED)
        wav = self.turn.utterance_wav()
        # start frame = max(0, 11 - 12 + 1 - 14) = 0; end = 49 + 1 + 15 = 65 frames
        expected_frames = 65
        self.assertEqual(len(wav), 44 + expected_frames * FRAME_BYTES)
        self.assertEqual(wav[:4], b"RIFF")

    def test_max_duration_cap_is_emergency_only(self):
        self.engine.push(True, 2000)
        feed(self.turn, server_vad.MAX_DURATION_MS // FRAME_MS)
        events = self.drain()
        self.assertEqual(events[-1]["type"], "turn_finalized")
        self.assertEqual(events[-1]["turn_finalize_reason"], "max_duration")

    def test_semantic_delay_defers_once_then_semantic_complete(self):
        self.engine.push(True, 50)
        self.engine.push(False, 39)
        feed(self.turn, 89)
        self.turn.note_partial("count one and", 89 * FRAME_MS)
        self.engine.push(False, 1)
        feed(self.turn, 1, 89)
        events = self.drain()
        types = [e["type"] for e in events]
        self.assertIn("vad_speech_end_candidate", types)
        self.assertIn("semantic_turn_wait", types)
        self.assertNotIn("turn_finalized", types)
        self.assertEqual(self.turn.state, server_vad.STATE_END_CANDIDATE)
        # 600ms more silence → semantic_complete
        self.engine.push(False, 30)
        feed(self.turn, 30, 90)
        events = self.drain()
        self.assertEqual(events[-1]["type"], "turn_finalized")
        self.assertEqual(events[-1]["turn_finalize_reason"], "semantic_complete")

    def test_semantic_delay_never_waits_indefinitely_and_only_once(self):
        self.engine.push(True, 50)
        self.engine.push(False, 39)
        feed(self.turn, 89)
        self.turn.note_partial("hello and", 89 * FRAME_MS)
        self.engine.push(False, 1)
        feed(self.turn, 1, 89)
        self.drain()
        # Resume speaking during the semantic window.
        self.engine.push(True, 30)
        feed(self.turn, 30, 90)
        self.assertEqual(self.turn.state, server_vad.STATE_RECEIVING)
        # Second long silence: semantic already used → immediate vad_silence.
        self.engine.push(False, 40)
        feed(self.turn, 40, 120)
        events = self.drain()
        types = [e["type"] for e in events]
        self.assertNotIn("semantic_turn_wait", types)
        self.assertEqual(events[-1]["turn_finalize_reason"], "vad_silence")

    def test_finalize_is_idempotent(self):
        self.engine.push(True, 50)
        self.engine.push(False, 40)
        feed(self.turn, 90)
        first = len(self.turn.events)
        self.assertFalse(self.turn.finalize("max_duration", 99999))
        self.assertEqual(len(self.turn.events), first, "no duplicate events after finalize")

    def test_frames_after_finalize_ignored(self):
        self.engine.push(True, 50)
        self.engine.push(False, 40)
        feed(self.turn, 90)
        count = len(self.turn.events)
        feed(self.turn, 10, 90)
        self.assertEqual(len(self.turn.events), count)


class ContinuationSignalTests(unittest.TestCase):
    def test_english_signals(self):
        self.assertTrue(server_vad._ends_with_continuation("I want one and"))
        self.assertTrue(server_vad._ends_with_continuation("wait because."))
        self.assertFalse(server_vad._ends_with_continuation("that is done"))
        self.assertFalse(server_vad._ends_with_continuation(""))

    def test_telugu_signals(self):
        self.assertTrue(server_vad._ends_with_continuation("నాకు ఇది కావాలి మరియు"))
        self.assertTrue(server_vad._ends_with_continuation("కానీ"))
        self.assertFalse(server_vad._ends_with_continuation("అవును"))


class ModeAndEngineTests(unittest.TestCase):
    def test_live_v2_recognized_but_falls_back_to_legacy(self):
        mode, fallback = server_vad.resolve_turn_mode("live_v2")
        self.assertEqual(mode, "legacy_client")
        self.assertEqual(fallback, "live_v2")

    def test_server_vad_v1_selected(self):
        mode, fallback = server_vad.resolve_turn_mode("server_vad_v1")
        self.assertEqual(mode, "server_vad_v1")
        self.assertIsNone(fallback)

    def test_default_is_legacy(self):
        mode, fallback = server_vad.resolve_turn_mode(None)
        self.assertEqual(mode, "legacy_client")
        self.assertIsNone(fallback)

    def test_unknown_mode_falls_back(self):
        mode, fallback = server_vad.resolve_turn_mode("webrtc_experimental")
        self.assertEqual(mode, "legacy_client")
        self.assertEqual(fallback, "unknown_mode:webrtc_experimental")

    def test_silero_request_falls_back_to_webrtc_without_runtime(self):
        engine = server_vad.create_engine("silero")
        self.assertIsInstance(engine, WebRtcVadEngine)

    def test_webrtc_engine_smoke(self):
        engine = WebRtcVadEngine(2)
        self.assertFalse(engine.is_speech(b"\x00" * FRAME_BYTES))
        self.assertFalse(engine.is_speech(b"\x00" * 10))  # bad length → False, no crash


if __name__ == "__main__":
    unittest.main()
