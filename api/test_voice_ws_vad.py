"""WebSocket integration tests for server_vad_v1 protocol.

Uses an energy-based test engine (deterministic on synthesized PCM fixtures)
and mocks Sarvam STT/TTS + agent so no provider network calls happen.
"""

from __future__ import annotations

import base64
import json
import math
import os
import struct
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

import agent
import db
import main
import sarvam
import server_vad
import voice_ws
from test_ws_helpers import voice_ws_path


class EnergyEngine:
    """Deterministic VAD: voiced when frame RMS exceeds threshold."""

    name = "energy"

    def is_speech(self, frame: bytes) -> bool:
        if len(frame) != server_vad.FRAME_BYTES:
            return False
        samples = struct.unpack(f"<{server_vad.FRAME_SAMPLES}h", frame)
        rms = math.sqrt(sum(s * s for s in samples) / len(samples))
        return rms > 1000


def pcm_chunk(ms: int, amplitude: int, freq: float = 220.0) -> bytes:
    """Synthesize 16kHz mono int16 PCM (sine for speech, near-silence for noise)."""
    samples = server_vad.SAMPLE_RATE * ms // 1000
    out = bytearray()
    for i in range(samples):
        value = int(amplitude * math.sin(2 * math.pi * freq * i / server_vad.SAMPLE_RATE))
        out += struct.pack("<h", value)
    return bytes(out)


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def fake_agent_result(**over):
    base = dict(
        route="converse", intent="chat", language="en", reply="Hi there",
        spoken_parts=["Hi there"], tools_used=[], max_spoken=0,
        open_camera=False, continue_listening=False, model_used="test-model", ask=None,
    )
    base.update(over)
    return types.SimpleNamespace(**base)


class RecordingEngine:
    """Captures every frame handed to the VAD; voiced when RMS exceeds threshold."""

    name = "recording"

    def __init__(self):
        self.frames: list[bytes] = []

    def is_speech(self, frame: bytes) -> bool:
        if len(frame) != server_vad.FRAME_BYTES:
            raise AssertionError(f"invalid frame length: {len(frame)}")
        self.frames.append(frame)
        samples = struct.unpack(f"<{server_vad.FRAME_SAMPLES}h", frame)
        rms = math.sqrt(sum(s * s for s in samples) / len(samples))
        return rms > 1000


class WsVadTests(unittest.TestCase):
    def setUp(self):
        self._old_db = db._DB_PATH
        self._tmp = tempfile.mkdtemp()
        db._DB_PATH = Path(self._tmp) / "test.db"
        db.init_db()
        voice_ws.reset_voice_debug_for_tests()

    def tearDown(self):
        db._DB_PATH = self._old_db

    def _patches(self):
        return (
            mock.patch.object(server_vad, "create_engine", lambda *a, **k: EnergyEngine()),
            mock.patch.object(sarvam, "listen", mock.Mock(return_value={"transcript": "hello setu", "language_code": "en-IN"})),
            mock.patch.object(agent, "run_agent_turn", mock.Mock(side_effect=lambda *a, **k: fake_agent_result())),
            mock.patch.object(sarvam, "speak", mock.Mock(return_value=pcm_chunk(100, 8000))),
        )

    def _recv_until(self, ws, predicate, limit=200):
        seen = []
        for _ in range(limit):
            msg = json.loads(ws.receive_text())
            seen.append(msg)
            if predicate(msg):
                return msg, seen
        self.fail(f"condition not met; saw types: {[m.get('type') for m in seen]}")

    def _send_chunks(self, ws, turn_id: int, pcm: bytes, seq_start: int = 0):
        """Send PCM in 100ms chunks with monotonically increasing sequence."""
        step = server_vad.SAMPLE_RATE * 2 * 100 // 1000
        seq = seq_start
        for offset in range(0, len(pcm), step):
            ws.send_text(json.dumps({
                "type": "audio.chunk",
                "voice_session_id": "ignored-client-side",
                "turn_id": turn_id,
                "sequence": seq,
                "pcm_base64": b64(pcm[offset:offset + step]),
                "sample_rate": 16000,
            }))
            seq += 1
        return seq

    def test_full_turn_speech_then_silence_runs_pipeline_exactly_once(self):
        p1, p2, p3, p4 = self._patches()
        with p1, p2, p3 as agent_mock, p4, mock.patch.dict(os.environ, {"VOICE_TURN_MODE": "server_vad_v1"}):
            client = TestClient(main.app)
            with client.websocket_connect(voice_ws_path("vad-it-1")) as ws:
                ready = json.loads(ws.receive_text())
                self.assertEqual(ready["type"], "ready")
                self.assertEqual(ready["voice_turn_mode"], "server_vad_v1")
                v2_ready = json.loads(ws.receive_text())
                self.assertEqual(v2_ready["type"], "voice_v2_ready")
                self.assertEqual(v2_ready["vad_engine"], "energy")

                speech = pcm_chunk(1000, 8000)
                silence = pcm_chunk(1200, 100)
                self._send_chunks(ws, 1, speech + silence)

                start_msg, seen1 = self._recv_until(ws, lambda m: m.get("type") == "vad_speech_start")
                self.assertEqual(start_msg["turn_id"], 1)
                final, seen2 = self._recv_until(ws, lambda m: m.get("type") == "turn_finalized")
                history = seen1 + seen2
                self.assertEqual(final["turn_finalize_reason"], "vad_silence")
                self.assertIn("voice_session_id", final)
                self.assertIsNotNone(final["first_audio_ms"])
                self.assertIsNotNone(final["finalize_latency_ms"])
                types = [m.get("type") for m in history]
                self.assertLess(types.index("vad_speech_start"), types.index("turn_finalized"))
                self.assertIn("vad_speech_end_candidate", types)

                # Existing STT/LLM/TTS pipeline runs exactly once.
                done, pipeline = self._recv_until(ws, lambda m: m.get("type") == "turn.done")
                types = [m.get("type") for m in pipeline]
                self.assertEqual(types.count("transcript"), 1)
                self.assertEqual(types.count("turn.done"), 1)
                self.assertEqual(done["transcript"], "hello setu")
                self.assertEqual(agent_mock.call_count, 1)

    def test_pause_and_continue_single_turn(self):
        p1, p2, p3, p4 = self._patches()
        with p1, p2, p3, p4, mock.patch.dict(os.environ, {"VOICE_TURN_MODE": "server_vad_v1"}):
            client = TestClient(main.app)
            with client.websocket_connect(voice_ws_path("vad-it-2")) as ws:
                ws.receive_text()
                ws.receive_text()
                stream = pcm_chunk(600, 8000) + pcm_chunk(500, 100) + pcm_chunk(600, 8000) + pcm_chunk(1000, 100)
                self._send_chunks(ws, 2, stream)
                final, history = self._recv_until(ws, lambda m: m.get("type") == "turn_finalized")
                self.assertEqual(final["turn_finalize_reason"], "vad_silence")
                self.assertEqual(final["turn_id"], 2)
                done, _ = self._recv_until(ws, lambda m: m.get("type") == "turn.done")
                self.assertEqual(done["transcript"], "hello setu")

    def test_semantic_wait_then_finalize(self):
        p1, p2, p3, p4 = self._patches()
        with p1, p2, p3, p4, mock.patch.dict(os.environ, {"VOICE_TURN_MODE": "server_vad_v1"}):
            client = TestClient(main.app)
            with client.websocket_connect(voice_ws_path("vad-it-3")) as ws:
                ws.receive_text()
                ws.receive_text()
                speech = pcm_chunk(800, 8000)
                self._send_chunks(ws, 3, speech)
                self._recv_until(ws, lambda m: m.get("type") == "vad_speech_start")
                ws.send_text(json.dumps({
                    "type": "partial_transcript", "turn_id": 3, "sequence": 100, "text": "one and",
                }))
                # 900ms silence crosses the 800ms end-candidate threshold.
                self._send_chunks(ws, 3, pcm_chunk(900, 100), seq_start=101)
                wait, _ = self._recv_until(ws, lambda m: m.get("type") in ("semantic_turn_wait", "turn_finalized"))
                self.assertEqual(wait["type"], "semantic_turn_wait")
                # 700ms more silence crosses the 600ms semantic deadline.
                self._send_chunks(ws, 3, pcm_chunk(700, 100), seq_start=200)
                final, _ = self._recv_until(ws, lambda m: m.get("type") == "turn_finalized")
                self.assertEqual(final["turn_finalize_reason"], "semantic_complete")
                self._recv_until(ws, lambda m: m.get("type") == "turn.done")

    def test_room_noise_only_never_finalizes_before_cap(self):
        p1, p2, p3, p4 = self._patches()
        with p1, p2, p3, p4, mock.patch.dict(os.environ, {"VOICE_TURN_MODE": "server_vad_v1"}):
            client = TestClient(main.app)
            with client.websocket_connect(voice_ws_path("vad-it-4")) as ws:
                ws.receive_text()
                ws.receive_text()
                self._send_chunks(ws, 4, pcm_chunk(2000, 100))
                # No speech → no events at all. Ping proves socket still healthy.
                ws.send_text(json.dumps({"type": "ping"}))
                pong = json.loads(ws.receive_text())
                self.assertEqual(pong["type"], "pong")

    def test_stale_turn_chunks_ignored(self):
        p1, p2, p3, p4 = self._patches()
        with p1, p2, p3, p4, mock.patch.dict(os.environ, {"VOICE_TURN_MODE": "server_vad_v1"}):
            client = TestClient(main.app)
            with client.websocket_connect(voice_ws_path("vad-it-5")) as ws:
                ws.receive_text()
                ws.receive_text()
                self._send_chunks(ws, 5, pcm_chunk(600, 8000))
                self._recv_until(ws, lambda m: m.get("type") == "vad_speech_start")
                # Stale turn id mid-turn: dropped, current turn continues.
                self._send_chunks(ws, 99, pcm_chunk(200, 8000), seq_start=500)
                self._send_chunks(ws, 5, pcm_chunk(1000, 100), seq_start=200)
                final, history = self._recv_until(ws, lambda m: m.get("type") == "turn_finalized")
                self.assertEqual(final["turn_id"], 5)
                self.assertTrue(all(m.get("turn_id") != 99 for m in history if m.get("type", "").startswith("vad")))
                self._recv_until(ws, lambda m: m.get("type") == "turn.done")

    def test_client_fallback_message_finalizes_with_buffered_audio(self):
        p1, p2, p3, p4 = self._patches()
        with p1, p2, p3, p4, mock.patch.dict(os.environ, {"VOICE_TURN_MODE": "server_vad_v1"}):
            client = TestClient(main.app)
            with client.websocket_connect(voice_ws_path("vad-it-6")) as ws:
                ws.receive_text()
                ws.receive_text()
                self._send_chunks(ws, 6, pcm_chunk(800, 8000))
                self._recv_until(ws, lambda m: m.get("type") == "vad_speech_start")
                ws.send_text(json.dumps({"type": "vad.client_fallback", "turn_id": 6, "sequence": 300}))
                final, _ = self._recv_until(ws, lambda m: m.get("type") == "turn_finalized")
                self.assertEqual(final["turn_finalize_reason"], "client_fallback")
                self._recv_until(ws, lambda m: m.get("type") == "turn.done")

    def test_live_v2_mode_not_implemented_and_legacy_still_works(self):
        p1, p2, p3, p4 = self._patches()
        with p1, p2, p3, p4, mock.patch.dict(os.environ, {"VOICE_TURN_MODE": "live_v2"}):
            client = TestClient(main.app)
            with client.websocket_connect(voice_ws_path("vad-it-7")) as ws:
                ready = json.loads(ws.receive_text())
                self.assertEqual(ready["voice_turn_mode"], "legacy_client")
                notice = json.loads(ws.receive_text())
                self.assertEqual(notice["type"], "mode_not_implemented")
                self.assertEqual(notice["mode"], "live_v2")
                # Legacy audio.utterance path still works (never a dead listening state).
                wav = pcm_chunk(500, 8000)
                ws.send_text(json.dumps({
                    "type": "audio.utterance",
                    "audio_base64": b64(b"RIFF" + b"\x00" * 40 + wav),
                }))
                done, _ = self._recv_until(ws, lambda m: m.get("type") == "turn.done")
                self.assertEqual(done["transcript"], "hello setu")

    def test_irregular_chunk_boundaries_preserve_all_bytes(self):
        """73ms + 127ms chunks: VAD must receive only exact 20ms frames, zero byte loss."""
        engine = RecordingEngine()
        with (
            mock.patch.object(server_vad, "create_engine", lambda *a, **k: engine),
            mock.patch.object(sarvam, "listen", mock.Mock(return_value={"transcript": "hello setu", "language_code": "en-IN"})),
            mock.patch.object(agent, "run_agent_turn", mock.Mock(side_effect=lambda *a, **k: fake_agent_result())),
            mock.patch.object(sarvam, "speak", mock.Mock(return_value=pcm_chunk(100, 8000))),
            mock.patch.dict(os.environ, {"VOICE_TURN_MODE": "server_vad_v1"}),
        ):
            client = TestClient(main.app)
            with client.websocket_connect(voice_ws_path("vad-it-9")) as ws:
                ws.receive_text()
                ws.receive_text()
                # Speech in irregular pieces: 73ms + 127ms + 31ms + 169ms = 400ms.
                speech = pcm_chunk(400, 8000)
                boundaries = [73, 127, 31, 169]
                seq = 0
                offset = 0
                sent = bytearray()
                for ms in boundaries:
                    size = server_vad.SAMPLE_RATE * 2 * ms // 1000
                    piece = speech[offset:offset + size]
                    offset += size
                    sent.extend(piece)
                    ws.send_text(json.dumps({
                        "type": "audio.chunk", "turn_id": 9, "sequence": seq, "pcm_base64": b64(piece),
                    }))
                    seq += 1
                # Silence in irregular pieces: 277ms x 4 = 1108ms → crosses 800ms.
                silence = pcm_chunk(1108, 100)
                offset = 0
                for _ in range(4):
                    piece = silence[offset:offset + 277 * server_vad.SAMPLE_RATE * 2 // 1000]
                    offset += len(piece)
                    sent.extend(piece)
                    ws.send_text(json.dumps({
                        "type": "audio.chunk", "turn_id": 9, "sequence": seq, "pcm_base64": b64(piece),
                    }))
                    seq += 1
                final, _ = self._recv_until(ws, lambda m: m.get("type") == "turn_finalized")
                self.assertEqual(final["turn_finalize_reason"], "vad_silence")
                self._recv_until(ws, lambda m: m.get("type") == "turn.done")

        # Every frame is exactly 640 bytes; concatenation is a byte-identical
        # prefix of everything sent — zero loss, duplication, or reordering.
        self.assertTrue(all(len(f) == server_vad.FRAME_BYTES for f in engine.frames))
        received = b"".join(engine.frames)
        self.assertEqual(len(received) % server_vad.FRAME_BYTES, 0)
        self.assertEqual(received, bytes(sent[: len(received)]))
        # All 400ms of speech reached the VAD (post-finalize trailing silence is
        # correctly rejected by the completed-turn guard).
        self.assertGreaterEqual(len(received), 400 * server_vad.SAMPLE_RATE * 2 // 1000)

    def test_legacy_mode_ignores_chunks(self):
        p1, p2, p3, p4 = self._patches()
        with p1, p2, p3, p4, mock.patch.dict(os.environ, {"VOICE_TURN_MODE": "legacy_client"}):
            client = TestClient(main.app)
            with client.websocket_connect(voice_ws_path("vad-it-8")) as ws:
                ready = json.loads(ws.receive_text())
                self.assertEqual(ready["voice_turn_mode"], "legacy_client")
                self._send_chunks(ws, 8, pcm_chunk(500, 8000))
                ws.send_text(json.dumps({"type": "ping"}))
                pong = json.loads(ws.receive_text())
                self.assertEqual(pong["type"], "pong")


if __name__ == "__main__":
    unittest.main()
