"""Signed session token helpers."""

from __future__ import annotations

import os
import unittest
from unittest import mock

import auth


class AuthSessionTokenTests(unittest.TestCase):
    def test_sign_and_verify_round_trip(self) -> None:
        with mock.patch.dict(os.environ, {"AUTH_SECRET": "unit-test-secret", "RENDER": ""}, clear=False):
            os.environ.pop("RENDER", None)
            token = auth.sign_session_token("user-123")
            self.assertTrue(token.startswith("user-123."))
            self.assertEqual(auth.verify_session_token(token), "user-123")

    def test_rejects_tampered_token(self) -> None:
        with mock.patch.dict(os.environ, {"AUTH_SECRET": "unit-test-secret"}, clear=False):
            token = auth.sign_session_token("user-123")
            bad = token[:-1] + ("0" if token[-1] != "0" else "1")
            self.assertIsNone(auth.verify_session_token(bad))
            self.assertIsNone(auth.verify_session_token("user-123"))
            self.assertIsNone(auth.verify_session_token(None))


if __name__ == "__main__":
    unittest.main()
