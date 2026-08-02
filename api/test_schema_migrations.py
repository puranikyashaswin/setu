"""schema_migrations migrate-on-boot."""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import db


class SchemaMigrationTests(unittest.TestCase):
    def test_init_db_records_schema_version(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "t.db"
            with mock.patch.dict(os.environ, {"DB_PATH": str(path)}, clear=False):
                db.init_db()
                with db._connect() as conn:
                    self.assertEqual(db.schema_version(conn), db.SCHEMA_VERSION)
                # Second boot is idempotent.
                db.init_db()
                with db._connect() as conn:
                    self.assertEqual(db.schema_version(conn), db.SCHEMA_VERSION)
                    count = conn.execute("SELECT COUNT(*) AS c FROM schema_migrations").fetchone()["c"]
                    self.assertEqual(count, 1)


if __name__ == "__main__":
    unittest.main()
