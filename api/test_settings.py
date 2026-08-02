"""Production settings validation."""

from __future__ import annotations

import os
import unittest
from unittest import mock

import settings


class SettingsTests(unittest.TestCase):
    def test_local_skips_require(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("RENDER", None)
            os.environ.pop("SETU_ENV", None)
            settings.require_production_settings()

    def test_production_lists_missing(self) -> None:
        with mock.patch.dict(os.environ, {"RENDER": "true"}, clear=False):
            for key in ("SARVAM_API_KEY", "DB_PATH", "CACHE_PATH", "AUTH_SECRET", "FRONTEND_ORIGIN"):
                os.environ.pop(key, None)
            missing = settings.validate_production_settings()
            self.assertIn("SARVAM_API_KEY", missing)
            self.assertIn("AUTH_SECRET", missing)
            with self.assertRaises(settings.SettingsError):
                settings.require_production_settings()


if __name__ == "__main__":
    unittest.main()
