# Production alerts

Minimum signals to watch for Setu in production:

| Signal | Source | Action |
|--------|--------|--------|
| `/health` non-200 | Uptime monitor (every 1–5 min) | Page on-call; check Render service |
| `/ready` non-200 | Same monitor or synthetic check | DB_PATH disk or SARVAM_API_KEY missing |
| HTTP 429 spike | Render / CDN logs | Rate-limit abuse or TTS/STT credit pressure |
| WS connect fail rate | Client Voice Health + API logs | Cold start, auth cookie, or CORS origin drift |
| STT/TTS/OCR p95 | Structured `[timing]` JSON logs | Sarvam latency or payload size |

Suggested monitors: free uptime ping on `https://<api>/health` and `https://<api>/ready`, plus a weekly review of Voice Health share reports from phones.
