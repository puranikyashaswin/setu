from __future__ import annotations

import struct
import unittest

from backend.app.llm.sarvam_streaming import SarvamRealtimeStt
from backend.app.realtime.audio import normalize_pcm16_mono


class AudioNormalizationTests(unittest.TestCase):
    def test_downmixes_stereo_pcm16_and_keeps_target_rate(self) -> None:
        stereo = struct.pack("<hhhh", 1000, 3000, -2000, 2000)
        normalized = normalize_pcm16_mono(stereo, sample_rate=16_000, channels=2)
        self.assertEqual(struct.unpack("<hh", normalized), (2000, 0))

    def test_resamples_pcm16_without_float_or_provider_dependency(self) -> None:
        source = struct.pack("<hhhh", 0, 1000, 2000, 3000)
        normalized = normalize_pcm16_mono(source, sample_rate=8_000, channels=1, target_sample_rate=16_000)
        self.assertEqual(len(normalized), 16)
        self.assertEqual(struct.unpack_from("<h", normalized, 0)[0], 0)
        self.assertEqual(struct.unpack_from("<h", normalized, -2)[0], 3000)


class SarvamTranscriptMessageTests(unittest.TestCase):
    def test_parses_partial_and_explicit_final_messages(self) -> None:
        partial = SarvamRealtimeStt._parse_transcript_message({"type": "transcript.partial", "text": "hel"})
        final = SarvamRealtimeStt._parse_transcript_message({"type": "transcript.final", "text": "hello"})
        self.assertEqual((partial.text, partial.final), ("hel", False))
        self.assertEqual((final.text, final.final), ("hello", True))

    def test_sdk_data_message_is_treated_as_final(self) -> None:
        update = SarvamRealtimeStt._parse_transcript_message({"type": "data", "data": {"transcript": "namaste"}})
        self.assertEqual((update.text, update.final), ("namaste", True))

    def test_provider_error_is_not_silently_accepted(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "quota"):
            SarvamRealtimeStt._parse_transcript_message({"type": "error", "data": {"message": "quota"}})
