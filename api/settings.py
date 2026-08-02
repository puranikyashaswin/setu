"""Fail-fast environment validation for production boots."""

from __future__ import annotations

import os
from pathlib import Path

import db

# Render "Secret Files" mount here as /etc/secrets/<FILENAME> — NOT as env vars.
_RENDER_SECRETS_DIR = Path("/etc/secrets")


class SettingsError(RuntimeError):
    pass


def read_secret_file(name: str) -> str:
    """Read a Render secret file by filename (e.g. AUTH_SECRET → /etc/secrets/AUTH_SECRET)."""
    path = _RENDER_SECRETS_DIR / name
    if not path.is_file():
        return ""
    try:
        return path.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def hydrate_env_from_secret_files() -> None:
    """Copy common secret-file contents into os.environ when the env var is unset.

    Many dashboards put AUTH_SECRET / DB_PATH under Secret Files by mistake.
    """
    for key in ("AUTH_SECRET", "DB_PATH", "CACHE_PATH", "SARVAM_API_KEY", "FRONTEND_ORIGIN"):
        if (os.getenv(key) or "").strip():
            continue
        value = read_secret_file(key)
        if value:
            os.environ[key] = value


def apply_render_disk_defaults() -> None:
    """Fill DB_PATH / CACHE_PATH for Render when unset.

    Prefer the Starter disk at /data. On Free (no disk) fall back to /tmp so the
    process can boot — data will not survive redeploys.
    AUTH_SECRET is never invented here (would rotate session cookies on every restart).
    """
    if not db.is_production():
        return
    if Path("/data").is_dir():
        os.environ.setdefault("DB_PATH", "/data/setu.db")
        os.environ.setdefault("CACHE_PATH", "/data/cache")
        return
    # Free tier / missing disk: still boot, but warn loudly.
    if not (os.getenv("DB_PATH") or os.getenv("SETU_DB_PATH") or "").strip():
        os.environ["DB_PATH"] = "/tmp/setu.db"
    if not (os.getenv("CACHE_PATH") or "").strip():
        os.environ["CACHE_PATH"] = "/tmp/setu-cache"
    print(
        "[startup] WARNING: /data disk not mounted — using /tmp for DB/cache "
        "(ephemeral on Free plan). Upgrade to Starter + attach disk at /data.",
        flush=True,
    )


def env_value(key: str) -> str:
    """Env var, else Render secret file with the same name."""
    return (os.getenv(key) or "").strip() or read_secret_file(key)


def validate_production_settings() -> list[str]:
    """Return missing keys; empty list means OK. Raises only when used via require_*."""
    missing: list[str] = []
    if not env_value("SARVAM_API_KEY"):
        missing.append("SARVAM_API_KEY")
    if not (env_value("DB_PATH") or env_value("SETU_DB_PATH")):
        missing.append("DB_PATH")
    if not env_value("CACHE_PATH"):
        missing.append("CACHE_PATH")
    if not env_value("AUTH_SECRET"):
        missing.append("AUTH_SECRET")
    if not env_value("FRONTEND_ORIGIN"):
        missing.append("FRONTEND_ORIGIN")
    return missing


def require_production_settings() -> None:
    if not db.is_production():
        return
    hydrate_env_from_secret_files()
    apply_render_disk_defaults()
    missing = validate_production_settings()
    if missing:
        raise SettingsError(
            "Missing required production env: " + ", ".join(missing)
            + ". On Render: add AUTH_SECRET, DB_PATH=/data/setu.db, CACHE_PATH=/data/cache "
            + "as Environment Variables (not Secret Files). Attach a disk mounted at /data."
        )
