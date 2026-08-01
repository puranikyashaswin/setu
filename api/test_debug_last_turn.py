"""GET /debug/last-turn freshness / cold-boot note."""

from __future__ import annotations

import unittest

import main
import voice_ws


class DebugLastTurnTests(unittest.TestCase):
    def setUp(self):
        voice_ws.reset_voice_debug_for_tests()
        main._LAST_TURN = {}

    def test_cold_boot_returns_server_restarted_note(self):
        payload = main.debug_last_turn()
        self.assertEqual(payload.get("note"), "server_restarted")
        self.assertIsNone(payload.get("voice_session_id"))
        self.assertEqual(payload.get("voice_events"), [])

    def test_after_voice_activity_keeps_session_without_restart_note(self):
        voice_ws.voice_log("sess-abc", "ws_connect")
        voice_ws.voice_log("sess-abc", "stt_done", chars=12)
        payload = main.debug_last_turn()
        self.assertNotIn("note", payload)
        self.assertEqual(payload.get("voice_session_id"), "sess-abc")
        self.assertGreaterEqual(len(payload.get("voice_events") or []), 2)

    def test_survives_without_active_socket(self):
        """Client disconnect must not wipe the last session id."""
        voice_ws.voice_log("sess-xyz", "ws_connect")
        voice_ws.voice_log("sess-xyz", "turn_done")
        # No active socket — ring + last session remain.
        self.assertEqual(voice_ws.last_voice_session_id(), "sess-xyz")
        payload = main.debug_last_turn()
        self.assertEqual(payload["voice_session_id"], "sess-xyz")
        self.assertTrue(payload["voice_events"])


if __name__ == "__main__":
    unittest.main()
