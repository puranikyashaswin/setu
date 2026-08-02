"""Contract: /health and /ready JSON shapes."""

from __future__ import annotations

import os
import unittest
from unittest import mock

from fastapi.testclient import TestClient


class HealthReadyContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        os.environ.setdefault("SARVAM_API_KEY", "test-key")
        # Ensure local (non-production) boot path.
        os.environ.pop("RENDER", None)
        os.environ.pop("SETU_ENV", None)
        import main

        cls.client = TestClient(main.app)

    def test_health_ok_shape(self) -> None:
        res = self.client.get("/health")
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertEqual(body.get("status"), "ok")
        self.assertEqual(body.get("db"), "ok")

    def test_ready_ok_shape(self) -> None:
        res = self.client.get("/ready")
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertEqual(body.get("status"), "ready")
        self.assertEqual(body.get("db"), "ok")


if __name__ == "__main__":
    unittest.main()
