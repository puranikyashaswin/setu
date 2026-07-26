# Setu

Voice-first document Q&A: scan a notice, ask in your language, get a spoken answer (Sarvam Vision + STT + LLM + TTS).

## Structure

- `api/` — FastAPI backend (`main.py`, `sarvam.py`)
- `web/` — Next.js frontend
- `samples/` — demo documents

## Setup

```bash
# 1) Secrets (never commit these)
cp .env.example .env
# edit .env → set SARVAM_API_KEY

cp web/.env.example web/.env.local
# default API URL is http://localhost:8000
```

### API

```bash
cd api
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

### Web

```bash
cd web
npm install
npm run dev
```

Open http://localhost:3000.

`npm run dev` uses **webpack** (stable on macOS). Turbopack is optional: `npm run dev:turbo`.

## Deploy as a PWA

Setu is installable after deployment over HTTPS. The service worker caches only the app shell and static assets; document scans, transcripts, answers, and audio always stay network-only.

1. Deploy `web/` to Vercel (or any Next.js-compatible host).
2. Deploy `api/` to a persistent Python host, such as Render, Railway, or Fly.io.
3. In the frontend deployment environment, set `NEXT_PUBLIC_API_URL` to the public HTTPS URL of the API.
4. In the API deployment environment, set `SARVAM_API_KEY` and `FRONTEND_ORIGIN` to the public frontend URL.
5. Open the deployed site on a phone and use the browser's **Install app** / **Add to Home Screen** action.

Microphone and camera access require HTTPS in production.


