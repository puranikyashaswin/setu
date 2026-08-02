#!/usr/bin/env python3
"""Write a turn to SQLite and read it back — local persistence smoke.

Usage (from repo root, with api on PYTHONPATH):
  cd api && python3 ../scripts/smoke_persist.py
  DB_PATH=/tmp/setu-smoke.db python3 ../scripts/smoke_persist.py
"""

from __future__ import annotations

import importlib
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
API = ROOT / "api"
sys.path.insert(0, str(API))

# Force an isolated DB unless the caller set DB_PATH.
if not (os.getenv("DB_PATH") or os.getenv("SETU_DB_PATH")):
    tmp = Path(tempfile.mkdtemp(prefix="setu-smoke-")) / "setu.db"
    os.environ["DB_PATH"] = str(tmp)

# Re-bind db module path after env is set.
import db  # noqa: E402

importlib.reload(db)


def main() -> int:
    db.init_db()
    user = db.ensure_user(None, is_guest=True)
    session = db.upsert_session(
        {
            "user_id": user["id"],
            "title": "Smoke persist",
            "language": "en-IN",
            "onboarded": True,
            "turns": [
                {"role": "user", "text": "hello smoke", "language": "en-IN"},
                {"role": "assistant", "text": "hi back", "language": "en-IN"},
            ],
        }
    )
    sid = session["id"]
    loaded = db.get_session(sid)
    assert loaded is not None, "session missing after write"
    assert loaded["language"] == "en-IN", loaded
    assert len(loaded["turns"]) == 2, loaded["turns"]
    assert loaded["turns"][0]["text"] == "hello smoke", loaded["turns"][0]
    assert loaded["turns"][1]["text"] == "hi back", loaded["turns"][1]

    again = db.get_session(sid)
    assert again and again["id"] == sid

    print(
        "smoke_persist_ok",
        f"db={db.db_path()}",
        f"user={user['id']}",
        f"session={sid}",
        f"turns={len(loaded['turns'])}",
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001
        print(f"smoke_persist_fail error={type(exc).__name__}: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
