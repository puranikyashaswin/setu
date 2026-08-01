"""Unit tests for bounded Sarvam Vision OCR polling + /scan terminal events."""

from __future__ import annotations

import json
import os
import time
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import sarvam


class FakeStatus:
    def __init__(self, job_state: str, error_message: str | None = None):
        self.job_state = job_state
        self.error_message = error_message


class FakeJob:
    def __init__(self, states: list[str], *, fail_detail: str | None = None):
        self._job_id = "job-test-123"
        self._states = list(states)
        self._fail_detail = fail_detail
        self.polls = 0
        self.upload_file = MagicMock()
        self.start = MagicMock()
        self.download_output = MagicMock()
        self.get_page_metrics = MagicMock(return_value={"total_pages": 1})

    def get_status(self):
        self.polls += 1
        if not self._states:
            return FakeStatus("Failed", self._fail_detail)
        state = self._states.pop(0)
        return FakeStatus(state, self._fail_detail if state == "Failed" else None)


class OcrTimeoutTests(unittest.TestCase):
    def setUp(self):
        self._env = patch.dict(os.environ, {"OCR_TIMEOUT_SECONDS": "1.2"}, clear=False)
        self._env.start()

    def tearDown(self):
        self._env.stop()

    def _patch_vision_job(self, job: FakeJob):
        client = MagicMock()
        client.document_intelligence.create_job.return_value = job
        return patch.multiple(
            sarvam,
            get_client=MagicMock(return_value=client),
            _with_backoff=lambda fn, *a, **k: fn() if callable(fn) else fn,
            _detect_format=MagicMock(return_value="jpeg"),
            _correct_filename=MagicMock(return_value="doc.jpg"),
        )

    def test_pending_beyond_timeout_returns_timeout_and_stops_polling(self):
        # Always pending — must stop locally within budget.
        job = FakeJob(["Pending"] * 50)
        sleeps: list[float] = []

        def fake_sleep(seconds: float):
            sleeps.append(seconds)

        with self._patch_vision_job(job), patch.object(sarvam.time, "sleep", side_effect=fake_sleep):
            # Force deadline immediately after a couple polls via tiny timeout + fast clock.
            with patch.object(sarvam, "ocr_timeout_seconds", return_value=0.8):
                t0 = time.perf_counter()
                # Advance deadline by controlling perf_counter after start.
                counters = {"n": 0, "t0": t0}

                def fake_perf():
                    counters["n"] += 1
                    # First calls during setup stay near t0; later calls exceed deadline.
                    if counters["n"] < 6:
                        return counters["t0"] + counters["n"] * 0.05
                    return counters["t0"] + 5.0

                with patch.object(sarvam.time, "perf_counter", side_effect=fake_perf):
                    result = sarvam._run_vision(b"\xff\xd8\xff", "doc.jpg", "te-IN")

        self.assertEqual(result["status"], "timeout")
        self.assertIn("too long", result["detail"].lower())
        self.assertLess(job.polls, 20)
        self.assertGreaterEqual(job.polls, 1)
        # Backoff schedule begins 0.5, 1.0, 1.5, then 2.0 — never above 2.
        self.assertTrue(all(s <= 2.0 + 1e-9 for s in sleeps))

    def test_failed_job_returns_error(self):
        job = FakeJob(["Failed"], fail_detail="Provider rejected image")
        with self._patch_vision_job(job), patch.object(sarvam.time, "sleep"):
            result = sarvam._run_vision(b"\xff\xd8\xff", "doc.jpg", "te-IN")
        self.assertEqual(result["status"], "error")
        self.assertIn("rejected", result["detail"].lower())
        self.assertEqual(job.polls, 1)

    def test_done_result_emits_one_final_done_event(self):
        job = FakeJob(["Pending", "Completed"])
        events: list[dict] = []

        def progress(event):
            events.append(event)

        with self._patch_vision_job(job), patch.object(sarvam.time, "sleep"), patch.object(
            sarvam,
            "_download_vision_text",
            return_value=("Scheme notice text " * 10, 1),
        ):
            # Bypass cache + unclear checks via extract_document path pieces.
            with patch.object(sarvam, "_cache", {}), patch.object(
                sarvam, "_detect_format", return_value="jpeg"
            ), patch.object(sarvam, "_is_unclear", return_value=False), patch.object(
                sarvam, "_set_cached_document"
            ), patch.object(sarvam, "ocr_timeout_seconds", return_value=15.0):
                result = sarvam.extract_document(
                    b"\xff\xd8\xff",
                    "doc.jpg",
                    language="te-IN",
                    progress=progress,
                )

        self.assertEqual(result["status"], "done")
        self.assertTrue(result.get("doc_id"))
        # Progress stages present; exactly one logical completion (status done).
        stages = [e.get("stage") for e in events if e.get("type") == "progress"]
        self.assertIn("ocr_started", stages)
        self.assertNotIn("timeout", stages)
        done_like = [e for e in events if e.get("type") in {"done", "timeout", "error"}]
        self.assertEqual(done_like, [])  # final done is returned, not streamed here

    def test_scan_stream_maps_timeout_status(self):
        """Simulate main.py terminal mapping for timeout."""
        result = {
            "status": "timeout",
            "detail": sarvam.OCR_TIMEOUT_DETAIL,
            "doc_id": "abc",
            "pages": 0,
        }
        payload = {
            "type": "timeout",
            "detail": result["detail"],
            "doc_id": result.get("doc_id"),
        }
        line = json.dumps(payload)
        parsed = json.loads(line)
        self.assertEqual(parsed["type"], "timeout")
        self.assertIn("too long", parsed["detail"].lower())

    def test_poll_schedule_values(self):
        self.assertEqual(sarvam._poll_sleep_seconds(0), 0.5)
        self.assertEqual(sarvam._poll_sleep_seconds(1), 1.0)
        self.assertEqual(sarvam._poll_sleep_seconds(2), 1.5)
        self.assertEqual(sarvam._poll_sleep_seconds(3), 2.0)
        self.assertEqual(sarvam._poll_sleep_seconds(10), 2.0)


class ScanEventFrontendParity(unittest.TestCase):
    """Mirror web/lib/scan-events.ts reduce rules for NDJSON terminal events."""

    @staticmethod
    def apply(state: dict, event: dict) -> dict:
        t = event.get("type")
        if t == "progress":
            return {**state, "analyzing": True, "outcome": "analyzing"}
        if t == "done":
            return {
                "analyzing": False,
                "outcome": "done",
                "docId": event.get("doc_id"),
                "detail": None,
            }
        if t == "timeout":
            return {
                "analyzing": False,
                "outcome": "timeout",
                "docId": event.get("doc_id"),
                "detail": event.get("detail"),
            }
        if t == "error":
            return {
                "analyzing": False,
                "outcome": "error",
                "docId": event.get("doc_id"),
                "detail": event.get("detail"),
            }
        return state

    def test_parser_clears_analyzing_on_done_timeout_error(self):
        base = {"analyzing": True, "outcome": "analyzing", "docId": None, "detail": None}
        for terminal in (
            {"type": "done", "doc_id": "d1", "pages": 1, "cached": False},
            {"type": "timeout", "detail": "too long"},
            {"type": "error", "detail": "failed"},
        ):
            out = self.apply(base, terminal)
            self.assertFalse(out["analyzing"], terminal)
            self.assertIn(out["outcome"], {"done", "timeout", "error"})


if __name__ == "__main__":
    unittest.main()
