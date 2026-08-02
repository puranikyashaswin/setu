# Secrets rotation

Rotate these whenever a key may have leaked or on a quarterly cadence.

| Secret | Where | How |
|--------|--------|-----|
| `SARVAM_API_KEY` | Render env | Create a new key in Sarvam dashboard → update Render → redeploy API |
| `AUTH_SECRET` | Render env | Generate a long random string → update Render → redeploy (invalidates signed session tokens) |
| `RESEND_API_KEY` | Render env | Rotate in Resend → update Render |
| `DEBUG_TOKEN` | Render env | New random string → update Render (old debug clients stop working) |
| `NEXT_PUBLIC_API_URL` | Vercel env | Not a secret, but rebuild web after every change |

## Rules

- Never commit `.env` / `.env.local`.
- Prefer dashboard “sync: false” secrets in `render.yaml`.
- After rotating `AUTH_SECRET`, users get a fresh guest session on next open.
