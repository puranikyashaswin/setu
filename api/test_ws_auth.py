"""Voice WebSocket identity resolution."""

from __future__ import annotations

import os
import unittest
from unittest import mock

import auth


class FakeWebSocket:
    def __init__(self, *, cookies=None, query=None, headers=None):
        self.cookies = cookies or {}
        self.query_params = query or {}
        self.headers = headers or {}


class WsAuthTests(unittest.TestCase):
    def test_accepts_signed_token_query(self) -> None:
        with mock.patch.dict(os.environ, {"AUTH_SECRET": "unit-secret", "RENDER": "true"}):
            token = auth.sign_session_token("user-abc")
            import voice_ws

            ws = FakeWebSocket(query={"token": token, "user_id": "spoofed"})
            self.assertEqual(voice_ws._ws_url_user(ws), "user-abc")

    def test_rejects_naked_user_id_in_production(self) -> None:
        with mock.patch.dict(os.environ, {"AUTH_SECRET": "unit-secret", "RENDER": "true"}):
            import voice_ws

            ws = FakeWebSocket(query={"user_id": "anyone"})
            self.assertIsNone(voice_ws._ws_url_user(ws))


if __name__ == "__main__":
    unittest.main()
