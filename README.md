# Setu

Voice-first document Q&A: scan a notice, ask in your language, get a spoken answer (Sarvam Vision + STT + LLM + TTS).

## Structure

- `api/` — FastAPI backend (`main.py`, `sarvam.py`, `db.py`, `auth.py`)
- `web/` — Next.js PWA frontend
- `samples/` — demo documents

---

## Run locally (no deploy needed)

### 1. One-time setup

```bash
cp .env.example .env
# Edit .env → set SARVAM_API_KEY=your_key

cp web/.env.example web/.env.local
# NEXT_PUBLIC_API_URL=http://localhost:8000
```

```bash
cd api
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

cd ../web
npm install
```

### 2. Start (two terminals)

**Terminal 1 — API**

```bash
cd api
source .venv/bin/activate
uvicorn main:app --reload --port 8000
```

**Terminal 2 — Web (development)**

```bash
cd web
npm run dev
```

Open **http://localhost:3000** in Chrome. Mic and camera work on `localhost` without HTTPS.

---

## Install as PWA (exact steps)

PWA install only works in **production** build, not `npm run dev`.

### On your laptop

```bash
# Terminal 1 — API (same as above, port 8000)

# Terminal 2 — Web production
cd web
npm run build
npm run start
```

1. Open **http://localhost:3000** in **Chrome** (not Safari on Mac for install button).
2. Look for the **Install** icon in the address bar (⊕ or computer icon).
3. Or: **⋮ menu → Save and share → Install Setu**.
4. Setu opens as a standalone app from your dock/home screen.

What's already wired: `web/app/manifest.ts`, `web/public/sw.js`, service worker registration in `layout.tsx`.

### On a phone (needs HTTPS)

Phones require HTTPS for mic/camera. Options:

| Method | When to use |
|--------|-------------|
| **Vercel deploy** (below) | Best for demos / judges |
| **ngrok tunnel** | Quick test without cloud |

**ngrok quick test:**

```bash
cd web && npm run build && npm run start   # port 3000
ngrok http 3000
```

Open the `https://….ngrok.io` URL on your phone → **Add to Home Screen** (iPhone Safari) or **Install app** (Android Chrome).

Also expose the API: `ngrok http 8000` and set `NEXT_PUBLIC_API_URL` to that HTTPS URL before `npm run build`.

### Installing on iPhone (exact steps)

iOS only installs PWAs from **Safari**, and only over HTTPS — a `192.168.x.x` address
will not offer install and will block the microphone.

1. Open your Vercel URL in **Safari** (not Chrome).
2. Tap the **Share** button (square with an arrow, bottom centre).
3. Scroll down and tap **Add to Home Screen** → **Add**.
4. Launch Setu from the home screen. It opens fullscreen with no Safari chrome.
5. On the first tap of the orb, iOS asks for microphone permission → **Allow**.
   Camera is requested separately, only when you ask Setu to read a document.

Before demoing, set **Settings → Display & Brightness → Auto-Lock → Never**. Setu holds
a screen wake lock while a conversation is live (iOS 16.4+), but Auto-Lock off is a
guaranteed backstop.

If you redeploy and the phone still shows the old version, close the app from the app
switcher and reopen it. The service worker fetches navigations from the network first,
so one relaunch is enough.

### Keeping the API awake

Render's free tier stops the container after 15 minutes idle; the next request then
waits 30–60s. Two ways to avoid that mid-demo:

- **Before a demo:** open `https://YOUR-API.onrender.com/health` and wait for
  `{"status":"ok"}`. Do this ~2 minutes before you present.
- **Continuously:** the `Keep API warm` GitHub Action pings `/health` every 10 minutes.
  Enable it by adding a repository variable (Settings → Secrets and variables → Actions
  → Variables) named `API_URL` set to your Render URL, then run it once manually from
  the Actions tab to confirm it returns 200.

---

## Deploy to Vercel + Render (showcase / judges)

### Step 1 — Push to GitHub

```bash
git add .
git commit -m "Deploy Setu"
git push origin main
```

### Step 2 — Backend on Render

1. Go to [render.com](https://render.com) → sign in with GitHub.
2. **New → Blueprint** → select your repo (uses `render.yaml` in repo root).
   - Or **New → Web Service** manually:
     - **Root Directory:** `api`
     - **Runtime:** Python 3
     - **Build Command:** `pip install -r requirements.txt`
     - **Start Command:** `uvicorn main:app --host 0.0.0.0 --port $PORT`
3. **Environment variables** (Render dashboard → Environment):

   | Key | Value |
   |-----|-------|
   | `SARVAM_API_KEY` | your Sarvam key |
   | `FRONTEND_ORIGIN` | `https://YOUR-APP.vercel.app` (fill after Vercel deploy) |
   | `EXPOSE_MAGIC_LINK` | `1` (optional, for demo login links) |

4. Deploy → copy your API URL, e.g. `https://setu-api.onrender.com`.
5. Test: open `https://setu-api.onrender.com/health` → should return `{"status":"ok"}`.

**Free tier note:** Render sleeps after ~15 min idle. Before a live demo, open `/health` once and wait ~30–60s for cold start.

### Step 3 — Frontend on Vercel

1. Go to [vercel.com](https://vercel.com) → **Add New → Project** → import your GitHub repo.
2. **Root Directory:** click Edit → set to `web`.
3. **Framework Preset:** Next.js (auto-detected).
4. **Environment Variables:**

   | Key | Value |
   |-----|-------|
   | `NEXT_PUBLIC_API_URL` | `https://setu-api.onrender.com` (your Render URL) |

5. Click **Deploy**.
6. Copy your Vercel URL, e.g. `https://setu.vercel.app`.

### Step 4 — Connect frontend ↔ backend

1. In **Render** → your API service → **Environment** → set:
   ```
   FRONTEND_ORIGIN=https://setu.vercel.app
   ```
2. **Manual Deploy** on Render to apply CORS change.

### Step 5 — Install PWA on phone

1. Open your **Vercel URL** on the phone (must be `https://`).
2. **iPhone (Safari):** Share → **Add to Home Screen**.
3. **Android (Chrome):** menu → **Install app** or the banner prompt.

---

## Product flow

1. **New chat** — tap the orb. Setu asks which language (voice). Say "Telugu", "Hindi", etc.
2. Setu speaks the intro **in that language** — how to show a document, ask questions, download answers.
3. Camera opens only when you ask to show a document.
4. **Old chats** open silently; tap to continue.
5. Hands-free after first tap. ~4.5s silence → **Tap to continue**.
6. Say **"speak in Hindi"** anytime to switch language.

## Auth notes

- **Guest mode:** automatic device ID, works immediately.
- **Magic link:** Settings → email → Send. Without Resend configured, the link appears in the UI for demos.

## Memory

Sessions sync to SQLite on the API (`api/cache/setu.db`) and IndexedDB in the browser. Recent chat summaries are injected into `/converse` for cross-session recall.
