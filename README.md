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


