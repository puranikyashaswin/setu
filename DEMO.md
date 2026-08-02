# Setu demo kit

## One-tap Voice Health (QR / Notes)

1. Deploy web + API.
2. Put this URL in Notes or a QR code:

```
https://YOUR-APP.vercel.app/voice-check?autorun=1
```

3. On the phone: open the link → **tap once** → speak close to the mic for ~2 seconds.
4. Share the report if anything is red/amber.
5. Open Setu and tap the orb.

## Before you present

1. Confirm GitHub `vars.API_URL` is set (keep-warm + nightly smoke).
2. Hit `GET /ready` once (wake cold start).
3. Run the phone DoD checklist in `README.md`.
4. Set iPhone Auto-Lock to Never for long demos.
