"""DB_PATH production guard."""

from __future__ import annotations

import os
import unittest
from unittest import mock

import db


class DbPathGuardTests(unittest.TestCase):
    def test_local_allows_missing_db_path(self) -> None:
        with mock.patch.dict(os.environ, {"RENDER": "", "SETU_ENV": "", "ENV": ""}, clear=False):
            os.environ.pop("RENDER", None)
            os.environ.pop("SETU_ENV", None)
            os.environ.pop("ENV", None)
            # Should not raise when not in production.
            db.require_db_path_configured()

    def test_production_requires_db_path(self) -> None:
        env = {
            "RENDER": "true",
            "DB_PATH": "",
            "SETU_DB_PATH": "",
        }
        with mock.patch.dict(os.environ, env, clear=False):
            os.environ.pop("DB_PATH", None)
            os.environ.pop("SETU_DB_PATH", None)
            with self.assertRaises(RuntimeError) as ctx:
                db.require_db_path_configured()
            self.assertIn("DB_PATH", str(ctx.exception))

    def test_production_ok_when_db_path_set(self) -> None:
        with mock.patch.dict(
            os.environ,
            {"RENDER": "true", "DB_PATH": "/data/setu.db"},
            clear=False,
        ):
            db.require_db_path_configured()


if __name__ == "__main__":
    unittest.main()
