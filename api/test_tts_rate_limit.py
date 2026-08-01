"""TTS serialization, 429 retry-once, and zero-TTS startup tests."""

from __future__ import annotations

import asyncio
import os
import threading
import time
import unittest
from unittest.mock import MagicMock, patch

from sarvamai.core.api_error import ApiError

import main as api_main
import sarvam


class StartupWarmupTests(unittest.TestCase):
    def test_startup_warmup_makes_zero_tts_requests(self):
        speak_calls: list[tuple] = []

        def fake_speak(*args, **kwargs):
            speak_calls.append((args, kwargs))
            return b"RIFF"

        with patch.dict(os.environ, {"SARVAM_API_KEY": "test-key"}, clear=False), patch.object(
            sarvam, "speak", side_effect=fake_speak
        ), patch.object(
            sarvam, "chat_reply", return_value={"reply": "hi", "language": "en"}
        ), patch.object(sarvam, "get_client", return_value=MagicMock()):
            asyncio.run(api_main._warmup_background())
            warm = api_main.warm()

        self.assertEqual(speak_calls, [])
        self.assertTrue(warm.get("tts_skipped"))


class TtsSerializeTests(unittest.TestCase):
    def setUp(self):
        sarvam._TTS_MEMORY.clear()
        with sarvam._LAZY_INTRO_WARM_LOCK:
            sarvam._LAZY_INTRO_WARM_STARTED = True  # disable lazy warm in these tests

    def test_three_concurrent_tts_serialize_to_one_in_flight(self):
        max_in_flight = 0
        lock = threading.Lock()

        def convert(**kwargs):
            nonlocal max_in_flight
            with lock:
                max_in_flight = max(max_in_flight, sarvam.tts_in_flight_count())
            time.sleep(0.05)
            return MagicMock(audios=[])

        client = MagicMock()
        client.text_to_speech.convert.side_effect = convert

        results: list[bytes] = []
        errors: list[BaseException] = []

        def worker(i: int):
            try:
                results.append(sarvam.speak(f"hello serialized {i}", "en"))
            except BaseException as exc:  # noqa: BLE001
                errors.append(exc)

        with patch.object(sarvam, "get_client", return_value=client), patch.object(
            sarvam, "_tts_to_wav", return_value=b"RIFFWAVE"
        ), patch.object(sarvam, "_tts_cache_get", return_value=None), patch.object(
            sarvam, "_tts_cache_put"
        ):
            threads = [threading.Thread(target=worker, args=(i,)) for i in range(3)]
            for t in threads:
                t.start()
            for t in threads:
                t.join(timeout=5)

        self.assertEqual(errors, [])
        self.assertEqual(len(results), 3)
        self.assertEqual(client.text_to_speech.convert.call_count, 3)
        self.assertEqual(max_in_flight, 1)

    def test_429_retries_once_then_structured_error(self):
        calls = {"n": 0}

        def convert(**kwargs):
            calls["n"] += 1
            raise ApiError(status_code=429, headers={"retry-after": "1"}, body="Too Many Requests")

        client = MagicMock()
        client.text_to_speech.convert.side_effect = convert
        sleeps: list[float] = []

        with patch.object(sarvam, "get_client", return_value=client), patch.object(
            sarvam, "_tts_cache_get", return_value=None
        ), patch.object(sarvam.time, "sleep", side_effect=lambda s: sleeps.append(s)):
            with self.assertRaises(sarvam.TtsError) as ctx:
                sarvam.speak("hello rate limit", "te")

        self.assertEqual(calls["n"], 2)
        self.assertEqual(sleeps, [1.0])
        self.assertEqual(ctx.exception.status, 429)

    def test_cache_hit_skips_provider(self):
        client = MagicMock()
        with patch.object(sarvam, "get_client", return_value=client), patch.object(
            sarvam, "_tts_cache_get", return_value=b"CACHED"
        ):
            out = sarvam.speak("cached phrase", "hi")
        self.assertEqual(out, b"CACHED")
        client.text_to_speech.convert.assert_not_called()


class SpokenCapTests(unittest.TestCase):
    def test_spoken_text_one_sentence_max_240(self):
        long = "First sentence here. " + ("word " * 80) + "Second still going."
        out = sarvam.spoken_text(long, 240)
        self.assertNotIn("Second", out)
        self.assertLessEqual(len(out), 240)

    def test_split_spoken_parts_is_single(self):
        import agent

        parts = agent._split_spoken_parts("One. Two. Three.", 240)
        self.assertEqual(len(parts), 1)


if __name__ == "__main__":
    unittest.main()
