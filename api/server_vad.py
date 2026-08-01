"""Server-side voice-turn VAD (server_vad_v1).

Engines:
  - WebRtcVadEngine  — default; tiny C ext, 20ms frames, GMM voiced/unvoiced.
  - SileroOnnxEngine — flagged upgrade; lazily loads onnxruntime + model and
                       falls back to WebRTC if either is unavailable.
Raw RMS is never the final decider.

Per-WebSocket ServerVoiceTurn state machine:
  idle -> receiving_speech -> possible_end -> finalized

Padding: 280ms prefix before confirmed start, 300ms trailing after last voicing.
Start: 240ms voiced (80ms gap tolerance). End: 800ms unvoiced after confirmed speech.
Semantic guard: a fresh partial transcript ending in a continuation signal
("and", "but", "because", ... + Telugu equivalents) may delay finalization
once, by <= 600ms. 15s max_duration is emergency-only.
Logs: timing/state/reason only — never audio contents.
"""

from __future__ import annotations

import logging
import os
import struct
from typing import Any, Protocol

logger = logging.getLogger("setu")

SAMPLE_RATE = 16000
FRAME_MS = 20
FRAME_SAMPLES = SAMPLE_RATE * FRAME_MS // 1000  # 320
FRAME_BYTES = FRAME_SAMPLES * 2  # int16 LE

PREFIX_MS = 280
TRAILING_MS = 300
SPEECH_START_MS = 240
START_GAP_TOLERANCE_MS = 80
SILENCE_END_MS = 800
MAX_DURATION_MS = 15000
SEMANTIC_DELAY_MS = 600
PARTIAL_STALE_MS = 2500

# Extensible: trailing-word continuation signals (EN + Telugu).
CONTINUATION_SIGNALS: tuple[str, ...] = (
    "and", "but", "because", "plus", "then", "also", "or", "so",
    "మరియు", "కానీ", "ఎందుకంటే", "అప్పుడు", "కూడా", "లేదా",
)

STATE_IDLE = "idle"
STATE_SPEECH_START = "speech_start"
STATE_RECEIVING = "receiving"
STATE_END_CANDIDATE = "end_candidate"
STATE_FINALIZED = "finalized"

MODE_LEGACY = "legacy_client"
MODE_SERVER_VAD = "server_vad_v1"
MODE_LIVE = "live_v2"
KNOWN_MODES = (MODE_LEGACY, MODE_SERVER_VAD, MODE_LIVE)


def resolve_turn_mode(raw: str | None) -> tuple[str, str | None]:
    """Resolve VOICE_TURN_MODE. live_v2 is recognized but unimplemented:
    deterministically falls back to legacy_client with mode_not_implemented."""
    mode = (raw or "").strip() or MODE_LEGACY
    if mode not in KNOWN_MODES:
        return MODE_LEGACY, f"unknown_mode:{mode}"
    if mode == MODE_LIVE:
        return MODE_LEGACY, MODE_LIVE
    return mode, None

REASON_VAD_SILENCE = "vad_silence"
REASON_SEMANTIC_COMPLETE = "semantic_complete"
REASON_MAX_DURATION = "max_duration"
REASON_CLIENT_FALLBACK = "client_fallback"


class VadEngine(Protocol):
    name: str

    def is_speech(self, frame: bytes) -> bool: ...


class WebRtcVadEngine:
    name = "webrtc"

    def __init__(self, aggressiveness: int = 2):
        import webrtcvad  # noqa: PLC0415 — lazy import keeps startup light

        self._vad = webrtcvad.Vad(aggressiveness)

    def is_speech(self, frame: bytes) -> bool:
        if len(frame) != FRAME_BYTES:
            return False
        try:
            return bool(self._vad.is_speech(frame, SAMPLE_RATE))
        except Exception:
            return False


class SileroOnnxEngine:
    """Silero VAD over ONNX. 32ms (512-sample) windows; 20ms frames are buffered."""

    name = "silero"
    WINDOW_SAMPLES = 512

    def __init__(self, model_path: str | None = None, threshold: float = 0.5):
        try:
            import onnxruntime as ort  # noqa: PLC0415
        except Exception as exc:
            raise RuntimeError(f"onnxruntime unavailable: {exc}") from exc
        path = model_path or os.getenv("SILERO_VAD_MODEL_PATH") or ""
        if not path or not os.path.exists(path):
            raise RuntimeError("silero model file missing (set SILERO_VAD_MODEL_PATH)")
        self._session = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
        self._threshold = threshold
        self._state = [[0.0] * 128 for _ in range(2)]
        self._buf = bytearray()
        self._last = False

    def is_speech(self, frame: bytes) -> bool:
        import numpy as np  # noqa: PLC0415

        self._buf.extend(frame)
        while len(self._buf) >= self.WINDOW_SAMPLES * 2:
            window = self._buf[: self.WINDOW_SAMPLES * 2]
            del self._buf[: self.WINDOW_SAMPLES * 2]
            pcm = struct.unpack(f"<{self.WINDOW_SAMPLES}h", bytes(window))
            x = np.array(pcm, dtype=np.float32) / 32768.0
            x = x.reshape(1, -1)
            state = np.array(self._state, dtype=np.float32).reshape(2, 1, 128)
            sr = np.array([SAMPLE_RATE], dtype=np.int64)
            out, new_state = self._session.run(
                None, {"input": x, "state": state, "sr": sr}
            )
            self._state = new_state.reshape(2, 128).tolist()
            self._last = float(out[0][0]) >= self._threshold
        return self._last


def create_engine(preferred: str | None = None, aggressiveness: int = 2) -> VadEngine:
    """Preferred engine with automatic WebRTC fallback."""
    choice = (preferred or os.getenv("SERVER_VAD_ENGINE") or "webrtc").strip().lower()
    if choice == "silero":
        try:
            engine = SileroOnnxEngine()
            logger.info("[vad] engine=silero loaded")
            return engine
        except Exception as exc:
            logger.warning("[vad] silero unavailable (%s) — falling back to webrtc", exc)
    logger.info("[vad] engine=webrtc aggressiveness=%s", aggressiveness)
    return WebRtcVadEngine(aggressiveness)


def _ends_with_continuation(text: str) -> bool:
    cleaned = text.strip().lower().rstrip(".,!?;:")
    if not cleaned:
        return False
    tail = cleaned.split()[-1]
    return tail in CONTINUATION_SIGNALS


def _wav_header(pcm_bytes: int) -> bytes:
    byte_rate = SAMPLE_RATE * 2
    return struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF", 36 + pcm_bytes, b"WAVE", b"fmt ", 16,
        1, 1, SAMPLE_RATE, byte_rate, 2, 16, b"data", pcm_bytes,
    )


class ServerVoiceTurn:
    """One authoritative server-side turn. Events collected in .events (drained by WS layer)."""

    def __init__(self, turn_id: int, engine: VadEngine, voice_session_id: str = "-"):
        self.turn_id = turn_id
        self.engine = engine
        self.voice_session_id = voice_session_id
        self.state = STATE_IDLE
        self.sequence = 0
        self.events: list[dict[str, Any]] = []
        self.finalize_reason: str | None = None
        # Server timing fields (ms, monotonic): emitted on turn_finalized.
        self.first_audio_ms: int | None = None
        self.speech_start_ms: int | None = None
        self.turn_finalized_ms: int | None = None

        self._pcm = bytearray()
        self._frame_index = 0
        self._first_frame_ms: int | None = None
        self._voiced_ms = 0
        self._start_gap_ms = 0
        self._speech_start_frame: int | None = None
        self._last_voiced_frame = -1
        self._unvoiced_run_ms = 0
        self._partial_text = ""
        self._partial_at_ms = 0
        self._semantic_used = False
        self._max_frames = MAX_DURATION_MS // FRAME_MS

    # ---- events -----------------------------------------------------------

    def _emit(self, type_: str, **fields: Any) -> None:
        self.sequence += 1
        event = {
            "type": type_,
            "voice_session_id": self.voice_session_id,
            "turn_id": self.turn_id,
            "sequence": self.sequence,
            **fields,
        }
        self.events.append(event)

    def drain_events(self) -> list[dict[str, Any]]:
        out, self.events = self.events, []
        return out

    # ---- input ------------------------------------------------------------

    def note_partial(self, text: str, now_ms: int) -> None:
        self._partial_text = text
        self._partial_at_ms = now_ms

    def accept_frame(self, frame: bytes, now_ms: int) -> None:
        if self.state == STATE_FINALIZED or len(frame) != FRAME_BYTES:
            return
        if self._first_frame_ms is None:
            self._first_frame_ms = now_ms
            self.first_audio_ms = int(now_ms)
        idx = self._frame_index
        self._frame_index += 1
        if len(self._pcm) < (self._max_frames + TRAILING_MS // FRAME_MS) * FRAME_BYTES:
            self._pcm.extend(frame)

        speech = self.engine.is_speech(frame)

        if self.state == STATE_IDLE:
            if speech:
                self._voiced_ms += FRAME_MS + self._start_gap_ms
                self._start_gap_ms = 0
                if self._voiced_ms >= SPEECH_START_MS:
                    self.state = STATE_RECEIVING
                    run_frames = self._voiced_ms // FRAME_MS
                    prefix_frames = PREFIX_MS // FRAME_MS
                    self._speech_start_frame = max(0, idx - run_frames + 1 - prefix_frames)
                    self._last_voiced_frame = idx
                    self.speech_start_ms = int(now_ms)
                    self._emit("vad_speech_start", engine=self.engine.name, voiced_ms=self._voiced_ms)
            else:
                self._start_gap_ms += FRAME_MS
                if self._start_gap_ms > START_GAP_TOLERANCE_MS:
                    self._voiced_ms = 0
        else:
            if speech:
                self._last_voiced_frame = idx
                self._unvoiced_run_ms = 0
                if self.state == STATE_END_CANDIDATE:
                    # User resumed during semantic delay — back to receiving.
                    self.state = STATE_RECEIVING
            else:
                self._unvoiced_run_ms += FRAME_MS

            if self.state == STATE_RECEIVING and self._unvoiced_run_ms >= SILENCE_END_MS:
                self.state = STATE_END_CANDIDATE
                if self._should_semantic_delay(now_ms):
                    self._semantic_used = True
                    self._emit(
                        "vad_speech_end_candidate",
                        engine=self.engine.name,
                        silence_ms=self._unvoiced_run_ms,
                        semantic_delay_ms=SEMANTIC_DELAY_MS,
                    )
                    self._emit("semantic_turn_wait", delay_ms=SEMANTIC_DELAY_MS)
                else:
                    self._emit(
                        "vad_speech_end_candidate",
                        engine=self.engine.name,
                        silence_ms=self._unvoiced_run_ms,
                        semantic_delay_ms=0,
                    )
                    self.finalize(REASON_VAD_SILENCE, now_ms)
            elif self.state == STATE_END_CANDIDATE:
                # Semantic wait is bounded by frame time: silence_end + delay, once.
                if self._unvoiced_run_ms >= SILENCE_END_MS + SEMANTIC_DELAY_MS:
                    self.finalize(REASON_SEMANTIC_COMPLETE, now_ms)

        if self.state != STATE_FINALIZED and self._frame_index >= self._max_frames:
            self.finalize(REASON_MAX_DURATION, now_ms)

    # ---- finalization -----------------------------------------------------

    def _should_semantic_delay(self, now_ms: int) -> bool:
        if self._semantic_used:
            return False
        if not self._partial_text or now_ms - self._partial_at_ms > PARTIAL_STALE_MS:
            return False
        return _ends_with_continuation(self._partial_text)

    def finalize(self, reason: str, now_ms: int) -> bool:
        """Idempotent — second and later calls are ignored."""
        if self.state == STATE_FINALIZED:
            return False
        self.state = STATE_FINALIZED
        self.finalize_reason = reason
        self.turn_finalized_ms = int(now_ms)
        duration_ms = (now_ms - self._first_frame_ms) if self._first_frame_ms is not None else 0
        finalize_latency_ms = (
            int(now_ms - (self._first_frame_ms + (self._last_voiced_frame + 1) * FRAME_MS))
            if self._first_frame_ms is not None and self._last_voiced_frame >= 0
            else None
        )
        self._emit(
            "turn_finalized",
            turn_finalize_reason=reason,
            duration_ms=int(duration_ms),
            heard_speech=self._speech_start_frame is not None,
            first_audio_ms=self.first_audio_ms,
            speech_start_ms=self.speech_start_ms,
            turn_finalized_ms=self.turn_finalized_ms,
            finalize_latency_ms=finalize_latency_ms,
        )
        return True

    # ---- output -----------------------------------------------------------

    def utterance_wav(self) -> bytes:
        """Buffered PCM sliced with prefix/trailing padding, as 16kHz mono WAV."""
        if self._speech_start_frame is None:
            return b""
        trailing_frames = TRAILING_MS // FRAME_MS
        end_frame = self._last_voiced_frame + 1 + trailing_frames
        total_frames = len(self._pcm) // FRAME_BYTES
        start = max(0, self._speech_start_frame)
        end = min(total_frames, max(end_frame, start + 1))
        pcm = bytes(self._pcm[start * FRAME_BYTES: end * FRAME_BYTES])
        return _wav_header(len(pcm)) + pcm
