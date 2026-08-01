"""SQLite persistence for users, sessions, turns, and magic-link tokens."""

from __future__ import annotations

import json
import os
import sqlite3
import time
import uuid
from pathlib import Path

# Prefer DB_PATH (Render disk: /data/setu.db). SETU_DB_PATH kept as legacy alias.
_DB_PATH = Path(
    os.getenv("DB_PATH")
    or os.getenv("SETU_DB_PATH")
    or "./cache/setu.db"
)


def _connect() -> sqlite3.Connection:
    _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(_DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db() -> None:
    with _connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
              id TEXT PRIMARY KEY,
              email TEXT UNIQUE,
              is_guest INTEGER NOT NULL DEFAULT 1,
              created_at REAL NOT NULL,
              last_seen_at REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS magic_links (
              token TEXT PRIMARY KEY,
              email TEXT NOT NULL,
              user_id TEXT,
              expires_at REAL NOT NULL,
              used_at REAL
            );

            CREATE TABLE IF NOT EXISTS sessions (
              id TEXT PRIMARY KEY,
              user_id TEXT NOT NULL,
              title TEXT NOT NULL,
              language TEXT NOT NULL,
              doc_id TEXT,
              document_name TEXT,
              summary TEXT,
              onboarded INTEGER NOT NULL DEFAULT 0,
              created_at REAL NOT NULL,
              updated_at REAL NOT NULL,
              FOREIGN KEY(user_id) REFERENCES users(id)
            );

            CREATE TABLE IF NOT EXISTS turns (
              id TEXT PRIMARY KEY,
              session_id TEXT NOT NULL,
              role TEXT NOT NULL,
              text TEXT NOT NULL,
              language TEXT NOT NULL,
              kind TEXT,
              evidence_json TEXT,
              ask_meta_json TEXT,
              document_image TEXT,
              created_at REAL NOT NULL,
              FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS documents (
              doc_id TEXT PRIMARY KEY,
              user_id TEXT,
              name TEXT,
              ocr_text TEXT NOT NULL,
              pages INTEGER NOT NULL DEFAULT 1,
              created_at REAL NOT NULL,
              last_used_at REAL NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, created_at);
            """
        )


def ensure_user(user_id: str | None = None, *, email: str | None = None, is_guest: bool = True) -> dict:
    now = time.time()
    with _connect() as conn:
        if email:
            row = conn.execute("SELECT * FROM users WHERE email = ?", (email.lower(),)).fetchone()
            if row:
                conn.execute("UPDATE users SET last_seen_at = ? WHERE id = ?", (now, row["id"]))
                return dict(row)
        if user_id:
            row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
            if row:
                conn.execute("UPDATE users SET last_seen_at = ? WHERE id = ?", (now, user_id))
                if email and not row["email"]:
                    conn.execute(
                        "UPDATE users SET email = ?, is_guest = 0 WHERE id = ?",
                        (email.lower(), user_id),
                    )
                    row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
                return dict(row)
        new_id = user_id or str(uuid.uuid4())
        # The client syncs a session on every state change, so two requests can reach
        # this insert with the same new id at once; the loser must not 500.
        conn.execute(
            "INSERT INTO users (id, email, is_guest, created_at, last_seen_at) "
            "VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET last_seen_at = ?",
            (
                new_id,
                email.lower() if email else None,
                1 if is_guest and not email else 0,
                now,
                now,
                now,
            ),
        )
        row = conn.execute("SELECT * FROM users WHERE id = ?", (new_id,)).fetchone()
        return dict(row)


def create_magic_link(email: str, user_id: str | None = None, ttl_seconds: int = 60 * 30) -> str:
    token = uuid.uuid4().hex
    now = time.time()
    with _connect() as conn:
        conn.execute(
            "INSERT INTO magic_links (token, email, user_id, expires_at) VALUES (?, ?, ?, ?)",
            (token, email.lower(), user_id, now + ttl_seconds),
        )
    return token


def consume_magic_link(token: str) -> dict | None:
    now = time.time()
    with _connect() as conn:
        row = conn.execute("SELECT * FROM magic_links WHERE token = ?", (token,)).fetchone()
        if not row or row["used_at"] or row["expires_at"] < now:
            return None
        user = ensure_user(row["user_id"], email=row["email"], is_guest=False)
        conn.execute("UPDATE magic_links SET used_at = ? WHERE token = ?", (now, token))
        return user


def list_sessions(user_id: str, limit: int = 20) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT * FROM sessions
            WHERE user_id = ?
            ORDER BY updated_at DESC
            LIMIT ?
            """,
            (user_id, limit),
        ).fetchall()
        return [dict(row) for row in rows]


def get_session(session_id: str, user_id: str | None = None) -> dict | None:
    with _connect() as conn:
        if user_id:
            row = conn.execute(
                "SELECT * FROM sessions WHERE id = ? AND user_id = ?",
                (session_id, user_id),
            ).fetchone()
        else:
            row = conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
        if not row:
            return None
        session = dict(row)
        turns = conn.execute(
            "SELECT * FROM turns WHERE session_id = ? ORDER BY created_at ASC",
            (session_id,),
        ).fetchall()
        session["turns"] = [_turn_from_row(turn) for turn in turns]
        return session


def upsert_session(payload: dict) -> dict:
    now = time.time()
    session_id = payload.get("id") or str(uuid.uuid4())
    with _connect() as conn:
        existing = conn.execute(
            "SELECT id, user_id FROM sessions WHERE id = ?", (session_id,)
        ).fetchone()
        if existing and existing["user_id"] != payload["user_id"]:
            # A session id belongs to exactly one user; never let another user overwrite it.
            raise PermissionError("Session belongs to a different user")
        if existing:
            conn.execute(
                """
                UPDATE sessions
                SET title = ?, language = ?, doc_id = ?, document_name = ?,
                    summary = COALESCE(?, summary), onboarded = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    payload.get("title") or "New chat",
                    payload.get("language") or "en",
                    payload.get("doc_id"),
                    payload.get("document_name"),
                    payload.get("summary"),
                    1 if payload.get("onboarded") else 0,
                    now,
                    session_id,
                ),
            )
        else:
            conn.execute(
                """
                INSERT INTO sessions (
                  id, user_id, title, language, doc_id, document_name, summary, onboarded, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    session_id,
                    payload["user_id"],
                    payload.get("title") or "New chat",
                    payload.get("language") or "en",
                    payload.get("doc_id"),
                    payload.get("document_name"),
                    payload.get("summary"),
                    1 if payload.get("onboarded") else 0,
                    payload.get("created_at") or now,
                    now,
                ),
            )
        if "turns" in payload:
            conn.execute("DELETE FROM turns WHERE session_id = ?", (session_id,))
            for turn in payload.get("turns") or []:
                conn.execute(
                    """
                    INSERT INTO turns (
                      id, session_id, role, text, language, kind, evidence_json, ask_meta_json, document_image, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        turn.get("id") or str(uuid.uuid4()),
                        session_id,
                        turn["role"],
                        turn["text"],
                        turn.get("language") or "en",
                        turn.get("kind"),
                        json.dumps(turn.get("evidence")) if turn.get("evidence") is not None else None,
                        json.dumps(turn.get("askMeta") or turn.get("ask_meta")) if (turn.get("askMeta") or turn.get("ask_meta")) else None,
                        turn.get("documentImage") or turn.get("document_image"),
                        turn.get("timestamp") or turn.get("created_at") or now,
                    ),
                )
    return get_session(session_id) or {}


def delete_session(session_id: str, user_id: str) -> None:
    with _connect() as conn:
        conn.execute("DELETE FROM sessions WHERE id = ? AND user_id = ?", (session_id, user_id))


def recent_session_summaries(user_id: str, exclude_session_id: str | None = None, limit: int = 5) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT id, title, language, summary, document_name, updated_at
            FROM sessions
            WHERE user_id = ?
            ORDER BY updated_at DESC
            LIMIT 12
            """,
            (user_id,),
        ).fetchall()
    out = []
    for row in rows:
        if exclude_session_id and row["id"] == exclude_session_id:
            continue
        out.append(dict(row))
        if len(out) >= limit:
            break
    return out


def recent_session_digests(
    user_id: str,
    exclude_session_id: str | None = None,
    limit: int = 4,
    turns_per_session: int = 6,
) -> list[dict]:
    """Recent chats with their last few turns, so Setu can recall actual content."""
    sessions = recent_session_summaries(user_id, exclude_session_id, limit=limit)
    if not sessions:
        return []
    out: list[dict] = []
    with _connect() as conn:
        for session in sessions:
            rows = conn.execute(
                """
                SELECT role, text FROM turns
                WHERE session_id = ?
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (session["id"], turns_per_session),
            ).fetchall()
            turns = [
                {"role": row["role"], "text": (row["text"] or "").strip()}
                for row in reversed(rows)
                if (row["text"] or "").strip()
                and (row["text"] or "").strip() not in {"Start conversation", "Scanned document"}
            ]
            if not turns and not (session.get("summary") or "").strip():
                continue
            out.append(
                {
                    "id": session["id"],
                    "title": session.get("title") or "Chat",
                    "summary": (session.get("summary") or "").strip(),
                    "document_name": session.get("document_name"),
                    "updated_at": session.get("updated_at"),
                    "turns": turns,
                }
            )
    return out


def save_document(doc_id: str, ocr_text: str, *, pages: int = 1, name: str | None = None, user_id: str | None = None) -> None:
    now = time.time()
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO documents (doc_id, user_id, name, ocr_text, pages, created_at, last_used_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(doc_id) DO UPDATE SET
              ocr_text = excluded.ocr_text,
              pages = excluded.pages,
              name = COALESCE(excluded.name, documents.name),
              user_id = COALESCE(excluded.user_id, documents.user_id),
              last_used_at = excluded.last_used_at
            """,
            (doc_id, user_id, name, ocr_text, pages, now, now),
        )


def get_document_text(doc_id: str) -> dict | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM documents WHERE doc_id = ?", (doc_id,)).fetchone()
        return dict(row) if row else None


def _turn_from_row(row: sqlite3.Row) -> dict:
    turn = {
        "id": row["id"],
        "role": "setu" if row["role"] in ("setu", "assistant") else row["role"],
        "text": row["text"],
        "language": row["language"],
        "kind": row["kind"],
        "timestamp": row["created_at"],
        "documentImage": row["document_image"],
    }
    if row["evidence_json"]:
        turn["evidence"] = json.loads(row["evidence_json"])
    if row["ask_meta_json"]:
        turn["askMeta"] = json.loads(row["ask_meta_json"])
    return turn
