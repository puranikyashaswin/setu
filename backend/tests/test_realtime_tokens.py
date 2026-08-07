from __future__ import annotations

import os
import unittest

from fastapi import HTTPException

from backend.app.api.realtime_tokens import issue_token, verify_session_token, verify_token
from backend.app.realtime.livekit import room_name_for_session


class RealtimeTokenTests(unittest.TestCase):
    def setUp(self) -> None:
        os.environ["SETU_REALTIME_TOKEN_SECRET"] = "test-secret"
        os.environ["REALTIME_TRANSPORT"] = "mock"

    def tearDown(self) -> None:
        os.environ.pop("SETU_REALTIME_TOKEN_SECRET", None)
        os.environ.pop("REALTIME_TRANSPORT", None)
        os.environ.pop("SETU_ROOM_NAMESPACE", None)

    def test_token_round_trip_contains_only_session_claims(self) -> None:
        token, _ = issue_token(user_id="user-1", session_id="session-1", language="te")
        claims = verify_token(token)
        self.assertEqual(claims["sub"], "user-1")
        self.assertEqual(claims["sid"], "session-1")
        self.assertEqual(claims["lang"], "te")
        self.assertNotIn("SARVAM_API_KEY", claims)

    def test_token_cannot_cross_user_or_session_boundary(self) -> None:
        token, _ = issue_token(user_id="user-1", session_id="session-1", language="en")
        self.assertEqual(verify_session_token(token, user_id="user-1", session_id="session-1")["sub"], "user-1")
        with self.assertRaises(HTTPException) as user_error:
            verify_session_token(token, user_id="user-2", session_id="session-1")
        self.assertEqual(user_error.exception.status_code, 403)
        with self.assertRaises(HTTPException) as session_error:
            verify_session_token(token, user_id="user-1", session_id="session-2")
        self.assertEqual(session_error.exception.status_code, 403)

    def test_livekit_room_namespace_is_stable_but_does_not_leak_identifiers(self) -> None:
        os.environ["SETU_ROOM_NAMESPACE"] = "setu-staging"
        room = room_name_for_session("session-1", "user-1")
        self.assertEqual(room, room_name_for_session("session-1", "user-1"))
        self.assertTrue(room.startswith("setu-staging-user_"))
        self.assertIn("-session_", room)
        self.assertNotIn("user-1", room)
        self.assertNotIn("session-1", room)
