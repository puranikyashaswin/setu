"""CACHE_PATH production guard."""

from __future__ import annotations

import os
import unittest
from unittest import mock

import paths


class CachePathGuardTests(unittest.TestCase):
    def test_local_allows_missing_cache_path(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("RENDER", None)
            os.environ.pop("SETU_ENV", None)
            os.environ.pop("ENV", None)
            paths.require_cache_path_configured()

    def test_production_requires_cache_path(self) -> None:
        with mock.patch.dict(os.environ, {"RENDER": "true"}, clear=False):
            os.environ.pop("CACHE_PATH", None)
            with self.assertRaises(RuntimeError) as ctx:
                paths.require_cache_path_configured()
            self.assertIn("CACHE_PATH", str(ctx.exception))

    def test_production_ok_when_cache_path_set(self) -> None:
        with mock.patch.dict(
            os.environ,
            {"RENDER": "true", "CACHE_PATH": "/data/cache"},
            clear=False,
        ):
            paths.require_cache_path_configured()


if __name__ == "__main__":
    unittest.main()
