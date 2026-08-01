"""Focused unit tests for language / scan / chat routing (no live Sarvam calls)."""

from __future__ import annotations

import unittest
from unittest.mock import patch

import agent
import sarvam


class LanguageRoutingTests(unittest.TestCase):
    def test_detect_telugu_variants(self):
        cases = [
            "Telugu",
            "తెలుగు.",
            "I speak Telugu",
            "nenu telugu matladutanu",
            "Telugu lo matladu",
            "I want Telugu",
        ]
        for utterance in cases:
            with self.subTest(utterance=utterance):
                self.assertEqual(agent.detect_language_request(utterance), "te")
                self.assertEqual(agent.to_bcp47("te"), "te-IN")

    def test_detect_english_and_hindi_phrases(self):
        self.assertEqual(agent.detect_language_request("speak in English"), "en")
        self.assertEqual(agent.to_bcp47("en"), "en-IN")
        self.assertEqual(agent.detect_language_request("Hindi mein baat karo"), "hi")
        self.assertEqual(agent.to_bcp47("hi"), "hi-IN")

    def test_new_session_language_pick_returns_intro(self):
        result = agent.run_agent_turn("Telugu", onboarded=False, use_tools=False)
        self.assertEqual(result.route, "language_switch")
        self.assertEqual(result.intent, "language_switch")
        self.assertEqual(result.language, "te-IN")
        self.assertTrue(result.reply.strip())
        self.assertIn("సేతు", result.reply)

    def test_existing_session_language_switch_ack(self):
        result = agent.run_agent_turn(
            "speak in English",
            language="te",
            onboarded=True,
            use_tools=False,
        )
        self.assertEqual(result.route, "language_switch")
        self.assertEqual(result.intent, "language_switch")
        self.assertEqual(result.language, "en-IN")
        self.assertEqual(result.reply, sarvam.language_switch_for_language("en"))

    def test_document_request_is_scan(self):
        result = agent.run_agent_turn(
            "I have a document",
            language="te",
            onboarded=True,
            use_tools=False,
        )
        self.assertEqual(result.route, "open_camera")
        self.assertEqual(result.intent, "scan")
        self.assertTrue(result.open_camera)
        self.assertTrue(result.reply.strip())
        self.assertNotIn("Rythu", result.reply)
        self.assertNotIn("Bharosa", result.reply)

    def test_normal_question_chat_nonempty(self):
        with patch.object(
            sarvam,
            "chat_reply",
            return_value={"reply": "Rain is expected tomorrow.", "intent": "chat"},
        ) as mocked:
            result = agent.run_agent_turn(
                "Will it rain tomorrow?",
                language="en",
                onboarded=True,
                use_tools=False,
            )
        mocked.assert_called_once()
        self.assertEqual(result.route, "converse")
        self.assertEqual(result.intent, "chat")
        self.assertTrue(result.reply.strip())

    def test_empty_model_reply_gets_fallback(self):
        with patch.object(
            sarvam,
            "chat_reply",
            return_value={"reply": "", "intent": "chat"},
        ):
            result = agent.run_agent_turn(
                "hello there friend",
                language="en",
                onboarded=True,
                use_tools=False,
            )
        self.assertEqual(result.route, "converse")
        self.assertTrue(result.reply.strip())


class BrowserSttContractTests(unittest.TestCase):
    """Client browser-STT unavailable errors must soft-fail (server STT continues)."""

    def test_unavailable_errors_declared_in_client(self):
        from pathlib import Path

        src = Path(__file__).resolve().parent.parent / "web" / "lib" / "audio" / "browser-stt.ts"
        text = src.read_text(encoding="utf-8")
        for err in ("service-not-allowed", "not-allowed", "network", "aborted"):
            self.assertIn(err, text)
        self.assertIn("isBrowserSttUnavailableError", text)
        self.assertIn("browserSttDisabled", text)

    def test_unavailable_helper_logic(self):
        # Mirror of web/lib/audio/browser-stt.ts — keep in sync.
        unavailable = {"service-not-allowed", "not-allowed", "network", "aborted"}

        def is_unavailable(error: str | None) -> bool:
            return (error or "").lower() in unavailable

        self.assertTrue(is_unavailable("service-not-allowed"))
        self.assertTrue(is_unavailable("not-allowed"))
        self.assertTrue(is_unavailable("network"))
        self.assertTrue(is_unavailable("aborted"))
        self.assertFalse(is_unavailable("no-speech"))
        # Empty browser transcript must not block a server STT turn.
        browser_text = "" if is_unavailable("service-not-allowed") else "hello"
        self.assertEqual(browser_text, "")


if __name__ == "__main__":
    unittest.main()
