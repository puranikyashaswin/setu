# Native deployment boundary

Deploy `backend.app.main:app` as a separate versioned service during the
migration. Keep `api/main.py` serving the current web product until native
push-to-talk, document flows, and auth have passed device testing.

The native service must set:

- `SETU_ENV=staging` and `SETU_ROOM_NAMESPACE=setu-staging`;
- `SETU_REALTIME_TOKEN_SECRET` to a stable secret;
- `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` in the API and
  worker environments;
- TURN on the LiveKit media plane for cellular/restricted networks. The
  self-hosted starting template is `livekit-server.example.yaml`; LiveKit
  Cloud can provide this layer without managing the UDP range directly;
- `SARVAM_API_KEY` only on the server process;
- the mobile API base URL through the native build configuration.

Do not put provider keys or TURN shared secrets in the React Native bundle.

Run the worker separately from the compatibility API:

```sh
python -m backend.app.realtime.livekit_worker
```

Before device testing, issue a token, verify the room is created under the
`setu-staging-user_<opaque>-session_<opaque>` namespace, and confirm that the
worker receives a dispatch. The direct Sarvam path is enabled by
`SARVAM_STT_TRANSPORT=direct_ws`; omit that flag to use the SDK compatibility
adapter during rollback.
