"""Fail-fast environment validation for production boots."""

from __future__ import annotations

import os

import db


class SettingsError(RuntimeError):
    pass


def validate_production_settings() -> list[str]:
    """Return missing keys; empty list means OK. Raises only when used via require_*."""
    missing: list[str] = []
    if not (os.getenv("SARVAM_API_KEY") or "").strip():
        missing.append("SARVAM_API_KEY")
    if not (os.getenv("DB_PATH") or os.getenv("SETU_DB_PATH") or "").strip():
        missing.append("DB_PATH")
    if not (os.getenv("CACHE_PATH") or "").strip():
        missing.append("CACHE_PATH")
    if not (os.getenv("AUTH_SECRET") or "").strip():
        missing.append("AUTH_SECRET")
    if not (os.getenv("FRONTEND_ORIGIN") or "").strip():
        missing.append("FRONTEND_ORIGIN")
    return missing


def require_production_settings() -> None:
    if not db.is_production():
        return
    missing = validate_production_settings()
    if missing:
        raise SettingsError(
            "Missing required production env: " + ", ".join(missing)
        )
