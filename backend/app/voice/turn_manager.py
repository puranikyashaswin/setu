"""Single-source-of-truth state machine for a realtime voice session."""

from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass, field
from typing import ClassVar

from backend.app.shared.protocol import VoiceState


class InvalidVoiceTransition(RuntimeError):
    """Raised when UI-style boolean changes try to bypass the FSM."""


@dataclass
class ActiveTurn:
    turn_id: str
    cancel_event: asyncio.Event = field(default_factory=asyncio.Event)
    heard_audio_ms: int = 0
    started_at_ms: int = field(default_factory=lambda: int(time.time() * 1000))


@dataclass
class VoiceSession:
    session_id: str
    user_id: str
    language: str = "en"
    state: VoiceState = "IDLE"
    active_turn: ActiveTurn | None = None
    _history: list[tuple[VoiceState, VoiceState]] = field(default_factory=list)

    _allowed: ClassVar[dict[VoiceState, set[VoiceState]]] = {
        "IDLE": {"CONNECTING"},
        "CONNECTING": {"READY", "ERROR", "RECONNECTING"},
        "READY": {"LISTENING", "RECONNECTING", "ERROR"},
        "LISTENING": {"USER_SPEAKING", "READY", "RECONNECTING", "ERROR"},
        "USER_SPEAKING": {"ENDPOINTING", "INTERRUPTED", "ERROR", "RECONNECTING"},
        "ENDPOINTING": {"THINKING", "LISTENING", "INTERRUPTED", "ERROR"},
        "THINKING": {"SPEAKING", "INTERRUPTED", "ERROR", "RECONNECTING"},
        "SPEAKING": {"LISTENING", "INTERRUPTED", "RECONNECTING", "ERROR"},
        "INTERRUPTED": {"LISTENING", "THINKING", "READY", "ERROR"},
        "RECONNECTING": {"READY", "ERROR", "CONNECTING"},
        "ERROR": {"RECONNECTING", "CONNECTING", "IDLE"},
    }

    @classmethod
    def new(cls, user_id: str, session_id: str | None = None, language: str = "en") -> "VoiceSession":
        return cls(session_id=session_id or str(uuid.uuid4()), user_id=user_id, language=language)

    def transition(self, next_state: VoiceState) -> None:
        if next_state == self.state:
            return
        if next_state not in self._allowed[self.state]:
            raise InvalidVoiceTransition(f"{self.state} -> {next_state} is not allowed")
        self._history.append((self.state, next_state))
        self.state = next_state

    def begin_turn(self, turn_id: str | None = None) -> ActiveTurn:
        if self.state not in {"READY", "LISTENING", "INTERRUPTED"}:
            raise InvalidVoiceTransition(f"cannot begin a turn from {self.state}")
        self.active_turn = ActiveTurn(turn_id=turn_id or str(uuid.uuid4()))
        if self.state != "LISTENING":
            self.transition("LISTENING")
        self.transition("USER_SPEAKING")
        return self.active_turn

    def endpoint(self) -> None:
        self._require_active_turn()
        self.transition("ENDPOINTING")

    def start_thinking(self) -> None:
        self._require_active_turn()
        self.transition("THINKING")

    def start_speaking(self) -> None:
        self._require_active_turn()
        self.transition("SPEAKING")

    def finish_turn(self) -> str:
        turn = self._require_active_turn()
        if self.state == "SPEAKING":
            self.transition("LISTENING")
        elif self.state in {"THINKING", "ENDPOINTING"}:
            self.transition("LISTENING")
        elif self.state == "INTERRUPTED":
            self.transition("LISTENING")
        else:
            raise InvalidVoiceTransition(f"cannot finish a turn from {self.state}")
        self.active_turn = None
        return turn.turn_id

    def fail_turn(self) -> str:
        """Clear a failed turn so the client can reconnect without replaying it."""

        turn = self._require_active_turn()
        turn.cancel_event.set()
        if self.state != "ERROR":
            self.transition("ERROR")
        self.active_turn = None
        return turn.turn_id

    def barge_in(self, reason: str = "speech_detected") -> str:
        turn = self._require_active_turn()
        turn.cancel_event.set()
        if self.state != "INTERRUPTED":
            self.transition("INTERRUPTED")
        return reason

    def reconnect(self) -> None:
        if self.active_turn:
            self.active_turn.cancel_event.set()
        if self.state != "RECONNECTING":
            self.transition("RECONNECTING")

    def history(self) -> list[tuple[VoiceState, VoiceState]]:
        return list(self._history)

    def _require_active_turn(self) -> ActiveTurn:
        if self.active_turn is None:
            raise InvalidVoiceTransition("no active turn")
        return self.active_turn
