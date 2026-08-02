"""Sentry bootstrap: scrubbing and no-op when SENTRY_DSN is unset."""

from __future__ import annotations

import os
import unittest
from unittest import mock

import observability


class ObservabilityTests(unittest.TestCase):
    def setUp(self) -> None:
        observability._INITIALIZED = False  # noqa: SLF001

    def test_scrub_filters_sensitive_keys(self) -> None:
        payload = {
            "transcript": "secret speech",
            "nested": {"message": "hello", "safe": "ok"},
            "items": [{"text": "line"}],
        }
        scrubbed = observability._scrub(payload)  # noqa: SLF001
        self.assertEqual(scrubbed["transcript"], "[Filtered]")
        self.assertEqual(scrubbed["nested"]["message"], "[Filtered]")
        self.assertEqual(scrubbed["nested"]["safe"], "ok")
        self.assertEqual(scrubbed["items"][0]["text"], "[Filtered]")

    def test_before_send_scrubs_event_sections(self) -> None:
        event = {
            "request": {"transcript": "voice"},
            "extra": {"reply": "answer"},
            "contexts": {"audio_base64": "AAAA"},
        }
        out = observability._before_send(event, {})  # noqa: SLF001
        self.assertEqual(out["request"]["transcript"], "[Filtered]")
        self.assertEqual(out["extra"]["reply"], "[Filtered]")
        self.assertEqual(out["contexts"]["audio_base64"], "[Filtered]")

    def test_init_sentry_noop_when_dsn_unset(self) -> None:
        env = {k: v for k, v in os.environ.items() if k != "SENTRY_DSN"}
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertFalse(observability.init_sentry())
            self.assertFalse(observability._INITIALIZED)  # noqa: SLF001

    def test_init_sentry_noop_when_dsn_blank(self) -> None:
        with mock.patch.dict(os.environ, {"SENTRY_DSN": "   "}, clear=False):
            self.assertFalse(observability.init_sentry())
            self.assertFalse(observability._INITIALIZED)  # noqa: SLF001


if __name__ == "__main__":
    unittest.main()
