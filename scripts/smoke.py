#!/usr/bin/env python3
"""Staging smoke: /health → /ready → /warm.

Usage:
  API_URL=https://setu-api.onrender.com python3 scripts/smoke.py
  python3 scripts/smoke.py   # defaults to http://localhost:8000
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

API_URL = (os.getenv("API_URL") or "http://localhost:8000").rstrip("/")


def get(path: str) -> tuple[int, dict | list | str]:
    req = urllib.request.Request(f"{API_URL}{path}", method="GET")
    try:
        with urllib.request.urlopen(req, timeout=45) as res:
            raw = res.read().decode("utf-8")
            try:
                return res.status, json.loads(raw)
            except json.JSONDecodeError:
                return res.status, raw
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            body: dict | list | str = json.loads(raw)
        except json.JSONDecodeError:
            body = raw
        return exc.code, body


def main() -> int:
    checks = [("/health", {200}), ("/ready", {200}), ("/warm", {200})]
    failed = False
    for path, ok_codes in checks:
        code, body = get(path)
        status = "ok" if code in ok_codes else "FAIL"
        if status != "ok":
            failed = True
        print(f"smoke {status} {path} http={code} body={body!r}"[:500])
    if failed:
        print("smoke_fail", file=sys.stderr)
        return 1
    print("smoke_ok", API_URL)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
