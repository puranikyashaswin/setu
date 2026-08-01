# Setu

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
├── api/          FastAPI backend (Sarvam STT/TTS/chat/Vision + optional fast OCR)
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
python -m unittest test_agent_routing -v
```

## Environment variables

### Backend (`.env` in repo root)

| Variable | Required | Description |
|----------|----------|-------------|
| `SARVAM_API_KEY` | Yes | Sarvam API key (STT / TTS / chat / Vision) |
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

**Free tier note:** Render sleeps after about 15 minutes of idle time. The first request after sleep can take 30 to 60 seconds. Before a live demo, open `/health` once and wait for a response.

**Free tier limitations:** On the free plan the filesystem is ephemeral — the SQLite database and OCR/TTS caches under `./cache/` reset on every restart or redeploy (scanned docs and chat history on the server are lost). Persistence requires either the Starter plan (uncomment the `disk` block and `DB_PATH` / `CACHE_PATH` env vars in `render.yaml`) or a hosted Postgres later.

### Step 3: Frontend on Vercel

1. Sign in at [vercel.com](https://vercel.com) and import the GitHub repository.
2. Set **Root Directory** to `web`.
3. **Framework Preset:** Next.js (auto-detected).
4. Set environment variable:

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

- **Guest mode:** A device ID is created automatically. No sign-up required.
- **Magic link:** Open Settings, enter your email, and tap Send. If Resend is not configured, the link appears in the UI for demo use.
- **AI routes** (`/voice`, `/listen`, `/ask`, `/speak`, `/scan`, `/converse`, `/summarize`) require the `X-User-Id` header from `/auth/guest`.

## Data and memory

- Server sessions are stored in SQLite at `api/cache/setu.db`.
- The browser keeps a local copy in IndexedDB.
- Recent chat summaries are sent to `/converse` so Setu can recall context across sessions.

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
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
