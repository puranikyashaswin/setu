# Native backend containers

The native backend boundary is intentionally separated from the current API
container. When the WebRTC signaling/media service is selected, add it as a
separate service here and keep Sarvam credentials in the backend environment.

Required production concerns before enabling native voice:

- a durable database/object store for users, sessions, documents, and OCR;
- Redis or equivalent for ephemeral cancellation/session state;
- LiveKit Cloud or self-hosted LiveKit as the SFU, with TURN enabled for
  cellular/restricted networks and short-lived room credentials;
- metrics and privacy-safe traces for the turn timestamps in
  `backend/app/shared/protocol.py`.

The first release should use LiveKit Cloud while the physical-device slice is
being proven. For self-hosting, pin a LiveKit server version, expose its
signaling endpoint over TLS, configure a public UDP range plus TURN/TLS, and
run the Python worker separately from the FastAPI compatibility service. Do
not commit LiveKit keys or TURN shared secrets.
