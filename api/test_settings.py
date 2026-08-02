"""Production settings validation."""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
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
            with mock.patch.object(settings, "read_secret_file", return_value=""):
                missing = settings.validate_production_settings()
            self.assertIn("SARVAM_API_KEY", missing)
            self.assertIn("AUTH_SECRET", missing)
            with mock.patch.object(settings.Path, "is_dir", return_value=False):
                with mock.patch.object(settings, "read_secret_file", return_value=""):
                    with self.assertRaises(settings.SettingsError):
                        settings.require_production_settings()

    def test_render_disk_defaults_fill_paths(self) -> None:
        with mock.patch.dict(os.environ, {"RENDER": "true"}, clear=False):
            for key in ("DB_PATH", "CACHE_PATH"):
                os.environ.pop(key, None)
            with mock.patch.object(settings, "_data_disk_usable", return_value=True):
                settings.apply_render_disk_defaults()
            self.assertEqual(os.environ.get("DB_PATH"), "/data/setu.db")
            self.assertEqual(os.environ.get("CACHE_PATH"), "/data/cache")

    def test_render_tmp_fallback_without_data_disk(self) -> None:
        with mock.patch.dict(os.environ, {"RENDER": "true"}, clear=False):
            for key in ("DB_PATH", "CACHE_PATH", "SETU_DB_PATH"):
                os.environ.pop(key, None)
            with mock.patch.object(settings, "_data_disk_usable", return_value=False):
                settings.apply_render_disk_defaults()
            self.assertEqual(os.environ.get("DB_PATH"), "/tmp/setu.db")
            self.assertEqual(os.environ.get("CACHE_PATH"), "/tmp/setu-cache")

    def test_overrides_data_paths_when_disk_missing(self) -> None:
        """Secret-file DB_PATH=/data/... must not crash Free plan with PermissionError."""
        with mock.patch.dict(
            os.environ,
            {"RENDER": "true", "DB_PATH": "/data/setu.db", "CACHE_PATH": "/data/cache"},
            clear=False,
        ):
            with mock.patch.object(settings, "_data_disk_usable", return_value=False):
                settings.apply_render_disk_defaults()
            self.assertEqual(os.environ.get("DB_PATH"), "/tmp/setu.db")
            self.assertEqual(os.environ.get("CACHE_PATH"), "/tmp/setu-cache")

    def test_hydrate_from_secret_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            secrets = Path(tmp)
            (secrets / "AUTH_SECRET").write_text("from-file-secret\n", encoding="utf-8")
            (secrets / "DB_PATH").write_text("/data/setu.db\n", encoding="utf-8")
            with mock.patch.object(settings, "_RENDER_SECRETS_DIR", secrets):
                with mock.patch.dict(os.environ, {}, clear=False):
                    os.environ.pop("AUTH_SECRET", None)
                    os.environ.pop("DB_PATH", None)
                    settings.hydrate_env_from_secret_files()
                    self.assertEqual(os.environ.get("AUTH_SECRET"), "from-file-secret")
                    self.assertEqual(os.environ.get("DB_PATH"), "/data/setu.db")


if __name__ == "__main__":
    unittest.main()
