# Setu mobile backend boundary

This is the new backend boundary for the native clients. The existing `api/`
application remains the compatibility/runtime path while this slice is built
out. New mobile code must depend on the contracts under `backend/app/`, not on
the legacy browser WebSocket payloads.

The first boundary is deliberately small:

- `POST /v1/realtime/sessions` creates a short-lived, server-issued session
  token. It contains no Sarvam credentials.
- `backend/app/shared/protocol.py` is the canonical cross-runtime voice event
  contract.
- `backend/app/voice/turn_manager.py` owns legal state transitions and
  cancellation semantics.
- Sarvam access stays behind provider interfaces under `backend/app/llm/`.

The realtime token is a short-lived LiveKit participant credential. Configure
`LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, and the matching
`LIVEKIT_AGENT_NAME` before enabling native voice. Run the media worker with:

```bash
PYTHONPATH=. python -m backend.app.realtime.livekit_worker start
```

The worker publishes assistant PCM on a LiveKit audio track and sends only
versioned `voice.v1` events over `setu-control-v1`. Keep LiveKit and Sarvam
secrets in the worker/API environment, never in the mobile bundle.

Run the boundary locally from the repository root:

```bash
PYTHONPATH=. uvicorn backend.app.main:app --reload --port 8100
```

This does not replace `api/main.py` yet.
