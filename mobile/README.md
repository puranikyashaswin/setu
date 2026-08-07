# Setu Mobile

This is a bare React Native shell. It shares product UI and protocol code
between iOS and Android; it does not load the existing Next.js app in a
WebView.

## Runtime boundaries

- React Native owns navigation, screens, design primitives, transcript state,
  document UX, and the voice FSM.
- `services/realtime.ts` owns LiveKit room connection and reliable control-data integration.
- `services/nativeAudio.ts` is the small bridge for audio-session routing,
  interruption handling, and immediate playback flush.
- `ios/SetuAudio/SetuAudio.swift` and
  `android/.../audio/SetuAudioModule.kt` contain platform-specific audio work.
- `backend/app/api/realtime_tokens.py` issues the short-lived session token.

The first media slice uses LiveKit as the SFU. The backend issues a short-lived
room-scoped token; the native app never receives `LIVEKIT_API_SECRET` or
`SARVAM_API_KEY`. `setu-control-v1` carries JSON state/turn events, while PCM
audio uses native LiveKit tracks.

Install and run after the native project files are generated/configured:

```bash
npm install
npm run typecheck
npx pod-install ios
npm run ios
# or
npm run android
```

Set `SETU_API_URL` in the native build environment to the URL serving
`backend.app.main:app`. The current guest identity is persisted in native
storage only as a migration-compatible placeholder for the existing auth
adapter.
