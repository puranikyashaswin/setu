"""Guest identity + email magic-link helpers."""

from __future__ import annotations

import hashlib
import hmac
import logging
import os
from urllib.parse import urlencode

import httpx

import db

logger = logging.getLogger("setu")

SESSION_COOKIE = "setu_session"


def _auth_secret() -> str:
    secret = (os.getenv("AUTH_SECRET") or "").strip()
    if secret:
        return secret
    # Local/dev fallback only — production should set AUTH_SECRET explicitly.
    if db.is_production():
        raise RuntimeError("AUTH_SECRET must be set in production")
    return "setu-dev-insecure-auth-secret"


def sign_session_token(user_id: str) -> str:
    """HMAC-signed token: user_id.signature (URL-safe for cookies/WS)."""
    uid = user_id.strip()
    digest = hmac.new(_auth_secret().encode("utf-8"), uid.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{uid}.{digest}"


def verify_session_token(token: str | None) -> str | None:
    """Return user_id if the signed token is valid; else None."""
    if not token or "." not in token:
        return None
    uid, _, sig = token.partition(".")
    if not uid or not sig:
        return None
    expected = hmac.new(_auth_secret().encode("utf-8"), uid.encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig, expected):
        return None
    return uid


def resolve_user(user_id: str | None, email: str | None = None) -> dict:
    return db.ensure_user(user_id, email=email, is_guest=not bool(email))


def request_magic_link(email: str, user_id: str | None = None) -> dict:
    email = email.strip().lower()
    if "@" not in email or "." not in email.split("@")[-1]:
        raise ValueError("Valid email required")
    user = db.ensure_user(user_id, email=None, is_guest=True)
    token = db.create_magic_link(email, user_id=user["id"])
    frontend = (os.getenv("FRONTEND_ORIGIN") or "http://localhost:3000").rstrip("/")
    link = f"{frontend}/?{urlencode({'magic': token})}"
    sent = _send_email(email, link)
    # Default off — only expose the raw link when explicitly enabled (local demos).
    expose = os.getenv("EXPOSE_MAGIC_LINK", "0") == "1"
    return {
        "ok": True,
        "email": email,
        "sent": sent,
        "magic_link": link if expose else None,
        "user_id": user["id"],
    }


def verify_magic_link(token: str) -> dict | None:
    return db.consume_magic_link(token)


def _send_email(email: str, link: str) -> bool:
    api_key = os.getenv("RESEND_API_KEY")
    if not api_key:
        logger.info("[auth] magic link for %s: %s", email, link)
        return False
    from_addr = os.getenv("RESEND_FROM", "Setu <onboarding@resend.dev>")
    try:
        response = httpx.post(
            "https://api.resend.com/emails",
            headers={"Authorization": f"Bearer {api_key}"},
            json={
                "from": from_addr,
                "to": [email],
                "subject": "Your Setu sign-in link",
                "html": (
                    "<p>Tap the link below to continue in Setu:</p>"
                    f'<p><a href="{link}">{link}</a></p>'
                    "<p>This link expires in 30 minutes.</p>"
                ),
            },
            timeout=20,
        )
        response.raise_for_status()
        return True
    except Exception:
        logger.exception("[auth] failed to send magic link email")
        return False
