# Latency dashboard (from API logs)

Structured timing lines already emit JSON with stage timings (`stt_ms`, `llm_ms`, `tts_ms`, `ocr_ms`, `request_id` / `turn_id` when present).

## Suggested views

1. **p95 STT** — filter `stage=stt` or `stt_ms` fields over 1h / 24h.
2. **p95 TTS** — same for `tts_ms` (watch Bulbul rate limits separately).
3. **p95 OCR** — `ocr_ms` / scan jobs; correlate with timeout count.
4. **Cold start** — time from process boot to first `/health` 200 after deploy.

Any log sink that can parse JSON (Render log drains, Axiom, Grafana Loki) is enough — no custom metrics service required for v1.
