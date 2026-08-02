# Voice turn modes

## Production default: `legacy_client`

- Client VAD (`TurnEndpoint` close-talk) decides when the user stopped speaking.
- Audio is uploaded as a turn WAV over `/ws/voice` (or REST `/voice` fallback).
- Most reliable on iPhone Safari today.

Set on Render: `VOICE_TURN_MODE=legacy_client`  
Optional web mirror: `NEXT_PUBLIC_VOICE_TURN_MODE=legacy_client`

## Staging soak: `server_vad_v1`

- Server webrtc/silero VAD finalizes turns from PCM chunks.
- Client locks the mode after `voice_v2_ready` (see `web/lib/voice-turn-v2.ts`).
- Do **not** flip production until phone DoD passes on both Safari and Chrome.

## Unimplemented: `live_v2`

- Recognized by the server as a future mode.
- Clients must never request it; treat as `mode_mismatch` → legacy.

## Flip checklist

1. Soak `server_vad_v1` on staging for a day of real phone sessions.
2. Capture `/debug/last-turn` + Voice Health reports for failures.
3. Change Render `VOICE_TURN_MODE` and rebuild web if using `NEXT_PUBLIC_*`.
4. Keep barge-in + auto-relisten DoD green before announcing.
