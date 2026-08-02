"""Rate-limit identity header and 429 enforcement."""

from __future__ import annotations

import unittest

from fastapi import HTTPException

import rate_limit


class RateLimitTests(unittest.TestCase):
    def test_require_user_id_missing_header(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            rate_limit.require_user_id(None)
        self.assertEqual(ctx.exception.status_code, 401)
        self.assertIn("X-User-Id", ctx.exception.detail)

    def test_require_user_id_blank_header(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            rate_limit.require_user_id("   ")
        self.assertEqual(ctx.exception.status_code, 401)

    def test_require_user_id_accepts_value(self) -> None:
        self.assertEqual(rate_limit.require_user_id("user-abc"), "user-abc")

    def test_check_rate_limit_returns_429_when_exceeded(self) -> None:
        user = "rate-limit-test-user"
        bucket = "unit-test-bucket"
        for _ in range(3):
            rate_limit.check_rate_limit(user, bucket=bucket, limit=3, window_s=60.0)
        with self.assertRaises(HTTPException) as ctx:
            rate_limit.check_rate_limit(user, bucket=bucket, limit=3, window_s=60.0)
        self.assertEqual(ctx.exception.status_code, 429)


if __name__ == "__main__":
    unittest.main()
