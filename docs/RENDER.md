# Render production env

Blueprint: [`render.yaml`](../render.yaml) (Starter + `/data` disk).

## Critical: Environment Variables ≠ Secret Files

| Feature | What it does | App sees it as |
|---------|----------------|----------------|
| **Environment Variables** | Key/value pairs | `os.getenv("AUTH_SECRET")` ✅ |
| **Secret Files** | Files under `/etc/secrets/<filename>` | Not env vars unless we copy them |

Put `AUTH_SECRET`, `DB_PATH`, and `CACHE_PATH` under **Environment Variables**.

## Required env vars

| Key | Value |
|-----|--------|
| `AUTH_SECRET` | Long random string (`openssl rand -hex 32`) |
| `DB_PATH` | `/data/setu.db` |
| `CACHE_PATH` | `/data/cache` |
| `FRONTEND_ORIGIN` | `https://your-app.vercel.app` |
| `SARVAM_API_KEY` | Your Sarvam key |

Also: **Disks** → mount path `/data` (Starter plan).
