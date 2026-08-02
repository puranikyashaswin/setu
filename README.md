# Setu

[![CI](https://github.com/puranikyashaswin/setu/actions/workflows/ci.yml/badge.svg)](https://github.com/puranikyashaswin/setu/actions/workflows/ci.yml)

Setu is a voice-first document assistant. Scan a notice or upload a file, ask questions in your language, and hear answers spoken back to you. The stack uses Sarvam for STT, TTS, chat, agent routing, and Vision OCR.

## Features

- Voice conversations in Indian languages (Telugu, Hindi, English, and more)
- Document scanning with Sarvam Vision OCR
- Hands-free Q&A after the first tap
- Progressive Web App (PWA) installable on desktop and mobile
- Guest mode with optional email magic-link sign-in
- Session history synced between browser and server

## Project structure

```
setu/
├── api/          FastAPI backend (Sarvam STT/TTS/chat/Vision OCR)
├── web/          Next.js PWA frontend
├── samples/      Demo documents for testing
├── render.yaml   Render deployment blueprint
└── .env.example  Backend environment template
```

## Prerequisites

- Python 3.12+
- Node.js 18+
- A [Sarvam API key](https://dashboard.sarvam.ai)
- Chrome (recommended for local development and PWA install)

## Local development

### 1. Configure environment

From the repository root:

```bash
cp .env.example .env
```

Edit `.env` and set your Sarvam key:

```
SARVAM_API_KEY=your_sarvam_api_key_here
```

For the frontend:

```bash
cp web/.env.example web/.env.local
```

The default API URL is fine for local work:

```
NEXT_PUBLIC_API_URL=http://localhost:8000
```

### 2. Install dependencies

**Backend**

```bash
cd api
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

**Frontend**

```bash
cd web
npm install
```

### 3. Start the services

Use two terminals.

**Terminal 1: API**

```bash
cd api
source .venv/bin/activate
uvicorn main:app --reload --port 8000
```

**Terminal 2: Web**

```bash
cd web
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in Chrome. Microphone and camera work on `localhost` without HTTPS.

Verify the API is running: [http://localhost:8000/health](http://localhost:8000/health) should return `{"status":"ok"}`.

### Run unit tests

```bash
cd api
source .venv/bin/activate
python -m unittest discover -s . -p 'test_*.py' -v
# Focused examples:
# python -m unittest test_agent_routing test_ocr_timeout test_tts_rate_limit \
#   test_server_vad test_voice_ws_vad test_debug_last_turn test_health_ready test_ws_auth -v

cd ../web
npm test
# or: node --experimental-strip-types --test lib/scan-events.test.ts lib/voice-loop.test.ts
```

### Manual scan / OCR checklist

1. Say you have a document → camera opens (scan intent).
2. Capture a clear page in good light → analyzing ends within ~5–15s with a short spoken summary; voice mode resumes.
3. Capture a blurry / dark page → timeout or unclear within ~15s server-side (client watchdog at 20s); analyzing clears; camera reopens with a retry message (spoken).
4. In Render logs, a finished scan shows one line like: `[ocr] doc_id=... status=done|timeout|error total_ms=... polls=N pages=N`. Timeouts also show `[scan] ocr_ms=...` with a prior NDJSON `type=timeout`.
5. Confirm startup warm-up does **not** call Vision / document-digitization (no job-status spam on boot).

### Manual TTS / mic checklist

1. Fresh Render restart: logs show `[warmup] tts_skipped=true reason=avoid_rate_limit` and **zero** Bulbul `text-to-speech` / `speak` calls before the first user turn.
2. Use **media volume** on the phone (not ringtone / notification volume).
3. Five Telugu voice turns: **no** chime, beep, repeated “tiding” thinking tone, volume ducking, overlap, or silent/stuck final turn. Only Setu’s spoken reply should be audible.
4. Interrupt one answer (talk over it): playback stops; exactly one `listening` / `mic_open` follows (no `mic_open_skipped … state=speaking` loop).
5. Client logs for a clean turn include `playback_finalize outcome=natural` (or `interrupted`) and never leave `voice_state` at `speaking` after `playback_end`.

## Environment variables

### Backend (`.env` in repo root)

| Variable | Required | Description |
|----------|----------|-------------|
| `SARVAM_API_KEY` | Yes | Sarvam API key (STT / TTS / chat / Vision) |
| `OCR_TIMEOUT_SECONDS` | No | Hard Vision job budget (default `15`) |
| `FRONTEND_ORIGIN` | For production | Deployed frontend URL, used for CORS and magic links |
| `RESEND_API_KEY` | No | Resend API key for email magic links |
| `RESEND_FROM` | No | Sender address for magic-link emails |
| `EXPOSE_MAGIC_LINK` | No | Set to `1` to show magic links in the UI when email is not configured |

### Frontend (`web/.env.local`)

| Variable | Required | Description |
|----------|----------|-------------|
| `NEXT_PUBLIC_API_URL` | Yes | Backend URL (e.g. `http://localhost:8000` or your Render URL) |

## Install as a PWA

PWA installation requires a production build. It does not work with `npm run dev`.

### Desktop (local production build)

```bash
# Terminal 1: API (same as above, port 8000)

# Terminal 2: Web production
cd web
npm run build
npm run start
```

1. Open [http://localhost:3000](http://localhost:3000) in Chrome.
2. Click the install icon in the address bar, or use the menu: **Save and share > Install Setu**.

PWA assets are configured in `web/app/manifest.ts`, `web/public/sw.js`, and service worker registration in `layout.tsx`.

### Mobile (requires HTTPS)

Phones require HTTPS for microphone and camera access. Use one of these options:

| Method | Best for |
|--------|----------|
| Vercel deployment (see below) | Demos and production use |
| ngrok tunnel | Quick testing without cloud deploy |

**ngrok quick test**

```bash
cd web && npm run build && npm run start   # port 3000
ngrok http 3000
```

Open the `https://....ngrok.io` URL on your phone.

Also expose the API with `ngrok http 8000`, set `NEXT_PUBLIC_API_URL` to that HTTPS URL, then rebuild the frontend.

**iPhone (Safari only)**

1. Open your HTTPS URL in Safari (not Chrome).
2. Tap **Share**, then **Add to Home Screen**, then **Add**.
3. Launch Setu from the home screen.
4. Allow microphone access when prompted. Camera access is requested only when you scan a document.

iOS will not offer PWA install or microphone access over a plain `192.168.x.x` LAN address.

For demos, set **Settings > Display & Brightness > Auto-Lock > Never**. Setu uses a screen wake lock during active conversations on iOS 16.4+, but disabling auto-lock is a reliable backup.

After redeploying, close the app from the app switcher and reopen it to pick up the latest version.

## Deployment

Setu splits into a Python API on Render and a Next.js frontend on Vercel.

### Step 1: Push to GitHub

```bash
git add .
git commit -m "Deploy Setu"
git push origin main
```

### Step 2: Backend on Render

1. Sign in at [render.com](https://render.com) with GitHub.
2. **New > Blueprint** and select this repository (uses `render.yaml`), or create a **Web Service** manually:
   - **Root Directory:** `api`
   - **Runtime:** Python 3
   - **Build Command:** `pip install -r requirements.txt`
   - **Start Command:** `uvicorn main:app --host 0.0.0.0 --port $PORT`
3. Set environment variables:

   | Key | Value |
   |-----|-------|
   | `SARVAM_API_KEY` | Your Sarvam key |
   | `FRONTEND_ORIGIN` | Your Vercel URL (set after frontend deploy) |
   | `EXPOSE_MAGIC_LINK` | `1` (optional, for demo login links) |

4. Deploy and copy your API URL, e.g. `https://setu-api.onrender.com`.
5. Confirm [https://setu-api.onrender.com/health](https://setu-api.onrender.com/health) returns `{"status":"ok"}`.

**Cold start / always-on:** Starter with a disk still may sleep depending on plan settings. If first-turn p95 exceeds ~5s in demos, keep the API always-on (paid) and confirm GitHub `vars.API_URL` powers [.github/workflows/keep-api-warm.yml](.github/workflows/keep-api-warm.yml). Before a live demo, open `/health` (or `/ready`) once and wait for a response.

**Persistent storage:** `render.yaml` uses the Starter plan with a `/data` disk. Production requires:

| Key | Value |
|-----|-------|
| `DB_PATH` | `/data/setu.db` |
| `CACHE_PATH` | `/data/cache` |

Without those, the API refuses to start on Render (avoids silent data loss on ephemeral disk).

#### Backup and restore (SQLite on `/data`)

**Backup** (from a shell with the DB file, or a one-off Render job):

```bash
DB_PATH=/data/setu.db BACKUP_DIR=/data/backups ./scripts/backup_sqlite.sh
```

**Restore** after a bad deploy or accidental wipe:

1. Stop or suspend the API service so nothing is writing to the DB.
2. Copy a known-good backup over the live file:
   ```bash
   cp /data/backups/setu-YYYYMMDDTHHMMSSZ.db /data/setu.db
   # remove stale WAL if you replaced the main file outside sqlite3:
   rm -f /data/setu.db-wal /data/setu.db-shm
   ```
3. Restart the API. Confirm `GET /health` returns `{"status":"ok","db":"ok",...}`.
4. Open the app, load an old chat — transcript + document text should restore without re-OCR.

#### Persistence DoD (after every Render restart)

- [ ] `GET /health` → `status=ok` and `db=ok`
- [ ] Create a guest chat, speak one turn, scan or attach a doc if available
- [ ] Note `session_id` / chat title
- [ ] Restart the Render service (or redeploy)
- [ ] Reopen the same chat — transcript, language, and document text restore
- [ ] Ask a doc question — answer is grounded; no re-OCR required

### Step 3: Frontend on Vercel

1. Sign in at [vercel.com](https://vercel.com) and import the GitHub repository.
2. Set **Root Directory** to `web`.
3. **Framework Preset:** Next.js (auto-detected).
4. Set environment variable (then **Redeploy** — `NEXT_PUBLIC_*` is baked at build time):

   | Key | Value |
   |-----|-------|
   | `NEXT_PUBLIC_API_URL` | Your Render API URL |

5. Deploy and copy your Vercel URL, e.g. `https://setu.vercel.app`.

### Step 4: Connect frontend and backend

1. In Render, open your API service **Environment** and set:
   ```
   FRONTEND_ORIGIN=https://setu.vercel.app
   ```
2. Trigger a **Manual Deploy** on Render to apply the CORS change.

### Step 5: Install on a phone

1. Open your Vercel URL on the phone (must be `https://`).
2. **iPhone (Safari):** Share > Add to Home Screen.
3. **Android (Chrome):** Menu > Install app, or use the install banner.

### Phone voice DoD (required before shipping)

Run on **iPhone Safari (tab + PWA)** and **Android Chrome (tab + PWA)**:

- [ ] Open `/voice-check?autorun=1` → tap once → speak close → overall Ready or Almost
- [ ] Main app: first orb tap greets once, then auto-listens
- [ ] Speak a turn → Setu replies → mic reopens without another tap
- [ ] Barge-in: speak during TTS → audio stops, new turn starts
- [ ] Background 30s → return → speak again (AudioContext/mic recover)
- [ ] After a web deploy: see **Update Setu** or force-quit and reopen PWA
- [ ] Scan a sample doc → ask a question grounded in the text
- [ ] Airplane mode offline shell shows network needed (no fake voice)

Demo QR / Notes link: `https://YOUR-APP.vercel.app/voice-check?autorun=1`

### Keep the API awake

Render's free tier stops the container after 15 minutes idle. To avoid cold starts during demos:

- **Before a demo:** Open `https://YOUR-API.onrender.com/health` about two minutes before you present.
- **Continuously:** Enable the `Keep API warm` GitHub Action. Add a repository variable named `API_URL` (Settings > Secrets and variables > Actions > Variables) set to your Render URL, then run the workflow once from the Actions tab to confirm it returns 200.

## How it works

1. **New chat:** Tap the orb. Setu asks which language you prefer. Say "Telugu", "Hindi", or another supported language.
2. **Intro:** Setu speaks instructions in your chosen language: how to show a document, ask questions, and download answers.
3. **Document scan:** The camera opens only when you ask to show a document.
4. **Resume chats:** Previous sessions open silently. Tap to continue where you left off.
5. **Hands-free mode:** After the first tap, conversation runs hands-free. About 4.5 seconds of silence triggers "Tap to continue".
6. **Language switch:** Say "speak in Hindi" (or any supported language) at any time to change language.

## Authentication

- **Guest mode:** `POST /auth/guest` returns `user_id` + signed `session_token` and sets an HttpOnly cookie.
- **Magic link:** Requires `RESEND_API_KEY` in production. Raw links are not returned unless `EXPOSE_MAGIC_LINK=1`.
- **AI routes** require `X-User-Id`. Voice WebSocket requires signed `token=` (or cookie) in production.
- Set `AUTH_SECRET` on Render for signing.

## Data and memory

- Server sessions are stored in SQLite at `DB_PATH` (production: `/data/setu.db`).
- OCR/TTS caches use `CACHE_PATH` (production: `/data/cache`).
- The browser keeps a local copy in IndexedDB.
- Recent chat summaries are sent to `/converse` so Setu can recall context across sessions.

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Liveness (DB readable) |
| GET | `/ready` | Readiness (DB writable + secrets) |
| POST | `/auth/guest` | Create or restore guest session |
| POST | `/auth/magic-link` | Request email magic link |
| POST | `/auth/magic-verify` | Verify magic link token |
| POST | `/intro` | Generate spoken intro for a language |
| GET | `/sessions` | List user sessions |
| GET | `/sessions/{id}` | Get session details |
| PUT | `/sessions/{id}` | Update session |
| DELETE | `/sessions/{id}` | Delete session |
| GET | `/voices` | List available TTS voices |
| GET | `/samples` | List demo documents |
| POST | `/scan` | OCR a document image or PDF |
| POST | `/voice` | One-shot STT → agent tools → LLM → TTS (HTTP fallback) |
| WS | `/ws/voice` | Persistent voice session (progressive TTS, cancel/barge-in) |
| POST | `/listen` | Speech-to-text from audio |
| POST | `/converse` | Multi-turn voice conversation |
| POST | `/ask` | Ask a question about a document |
| POST | `/summarize` | Summarize document content |
| POST | `/speak` | Text-to-speech |
| GET | `/warm` | Keep-alive that touches TTS cache |
