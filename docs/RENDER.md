# Render production env

Blueprint: [`render.yaml`](../render.yaml) (Starter + `/data` disk).

| Variable | Source | Notes |
|----------|--------|-------|
| `DB_PATH` | `/data/setu.db` in blueprint | Also auto-defaulted at boot if `/data` exists |
| `CACHE_PATH` | `/data/cache` in blueprint | Same auto-default |
| `AUTH_SECRET` | `generateValue: true` | Set once in dashboard if Blueprint never synced |
| `FRONTEND_ORIGIN` | Dashboard (`sync: false`) | e.g. `https://setu-vert.vercel.app` |
| `SARVAM_API_KEY` | Dashboard (`sync: false`) | Required |
| `RESEND_*` | Dashboard | Optional until magic-link email is used |

If deploy fails with `Missing required production env: … AUTH_SECRET`:

1. Open Render → `setu-api` → Environment
2. Add `AUTH_SECRET` (long random string) if missing
3. Confirm `DB_PATH=/data/setu.db` and `CACHE_PATH=/data/cache`
4. Confirm the disk is mounted at `/data`
5. Manual Deploy
