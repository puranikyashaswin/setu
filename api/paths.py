"""Durable data paths (Render disk: /data)."""

from __future__ import annotations

import os
from pathlib import Path

import db


def cache_dir() -> Path:
    return Path(os.getenv("CACHE_PATH") or "./cache/")


def require_cache_path_configured() -> None:
    """Fail loud in production if CACHE_PATH was not set (OCR/TTS would be ephemeral)."""
    if not db.is_production():
        return
    configured = (os.getenv("CACHE_PATH") or "").strip()
    if not configured:
        raise RuntimeError(
            "CACHE_PATH must be set in production (e.g. /data/cache on the Render disk). "
            "Refusing to start with the local ./cache default."
        )


def ensure_data_dirs() -> tuple[Path, Path]:
    """Create DB parent + cache dirs; returns (db_path, cache_dir)."""
    require_cache_path_configured()
    db.require_db_path_configured()
    cdir = cache_dir()
    cdir.mkdir(parents=True, exist_ok=True)
    (cdir / "tts").mkdir(parents=True, exist_ok=True)
    db_path = db.db_path()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    return db_path, cdir
