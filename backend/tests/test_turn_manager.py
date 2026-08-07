from __future__ import annotations

import unittest

from backend.app.voice.turn_manager import InvalidVoiceTransition, VoiceSession


class VoiceSessionTests(unittest.TestCase):
    def test_turn_lifecycle_is_single_state_machine(self) -> None:
        session = VoiceSession.new("user-1", session_id="session-1")
        session.transition("CONNECTING")
        session.transition("READY")
        turn = session.begin_turn("turn-1")
        self.assertEqual(session.state, "USER_SPEAKING")
        self.assertEqual(turn.turn_id, "turn-1")
        session.endpoint()
        session.start_thinking()
        session.start_speaking()
        self.assertEqual(session.finish_turn(), "turn-1")
        self.assertEqual(session.state, "LISTENING")

    def test_barge_in_cancels_active_turn_and_late_work_cannot_finish(self) -> None:
        session = VoiceSession.new("user-1")
        session.transition("CONNECTING")
        session.transition("READY")
        turn = session.begin_turn("turn-1")
        session.endpoint()
        session.start_thinking()
        session.barge_in()
        self.assertTrue(turn.cancel_event.is_set())
        self.assertEqual(session.state, "INTERRUPTED")
        self.assertEqual(session.finish_turn(), "turn-1")

    def test_illegal_boolean_style_jump_is_rejected(self) -> None:
        session = VoiceSession.new("user-1")
        with self.assertRaises(InvalidVoiceTransition):
            session.transition("SPEAKING")
