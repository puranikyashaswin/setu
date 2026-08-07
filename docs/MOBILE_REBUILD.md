# Native mobile rebuild

The repository now has an additive native-client boundary. The existing
`api/` + `web/` path remains the reference implementation while the native
runtime is migrated feature by feature.

## Contract decisions

- React Native bare workflow; no WebView wrapper.
- LiveKit is the production SFU/media transport. A reliable data channel named
  `setu-control-v1` carries small control events; audio never travels through
  React state or JSON.
- Native audio modules own route/session/interruption concerns. The app stops
  local playback before sending `turn.cancel`.
- `voice.v1` events require both `sessionId` and `turnId`. Late events from an
  interrupted turn are ignored by the mobile reducer.
- `POST /v1/realtime/sessions` returns only a short-lived session token. Sarvam
  credentials and document permissions remain on the server.
- Sarvam policy is `sarvam-105b` for answers, `saaras:v3` streaming STT, and
  `bulbul:v3` for TTS. Ordinary voice turns use no reasoning; document and
  tool turns use low reasoning; complex text-first work may use medium.

## Current slice

Implemented:

- design tokens extracted from the current visual language;
- typed Python/TypeScript voice protocol;
- legal-state FSM and stale-event protection;
- short-lived realtime token endpoint;
- bounded LLM context and model policy;
- cancellable server worker seam;
- React Native screens/navigation/design primitives;
- iOS and Android audio-session module seams.

Not yet production-enabled:

- LiveKit Cloud/self-hosted SFU and TURN deployment, including health checks;
- generated Xcode/Gradle project files and device certificates;
- production provider quotas, retries, and observability;
- camera upload, durable native database, background uploads, and crash/latency
  telemetry.

## Migration order

1. Configure LiveKit Cloud or self-hosted LiveKit with TURN and deploy the
   `backend.app.realtime.livekit_worker` process.
2. Generate native projects, install pods/Gradle dependencies, and verify the
   push-to-talk path on physical iPhone and Android hardware.
3. Migrate auth/session/document APIs behind versioned backend routes.
4. Add provider retry budgets, latency traces, and 50-turn device soak tests.
5. Add local VAD, hands-free relisten, and barge-in only after the push-to-talk
   slice is stable.
6. Release the native shell to internal testing before retiring the web path.
