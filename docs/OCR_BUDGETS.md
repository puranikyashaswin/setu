# OCR / scan budgets

| Budget | Value | Where |
|--------|-------|-------|
| Server OCR wall time | ~15s | `api` OCR job timeout |
| Client scan watchdog | 20s | `web` scan flow |
| Max upload size | `MAX_SCAN_BYTES` | `api/rate_limit.py` |
| Client preprocess | Downscale before upload | `web/lib/preprocess-scan.ts` |

Timeouts must clear the analyzing UI and speak a retry phrase — never leave the orb stuck on “analyzing.”
