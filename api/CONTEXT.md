# Setu — Product & Architecture Context (v2)

## What Setu is
A voice-first AI assistant for Indian people who may be non-technical or low-literacy.
Two capabilities inside ONE continuous voice conversation:
1. **Talk** — free conversation in the user's own language (questions, daily help,
   general knowledge).
2. **Documents** — user shows a paper (govt notice/form, bank letter, medical
   prescription, land record, school document); Setu scans it once, speaks a short
   summary of what it is, then answers questions about it spoken aloud, grounded
   ONLY in the scanned text, abstaining rather than inventing.

Reference UX: ChatGPT voice mode. Hands-free, interruptible, context-holding.
NOT: a chatbot with a mic button. NOT: a one-trick Rythu Bharosa demo.

## Users
Non-technical Indian phone users. Android Chrome AND iPhone Safari must both work.
No literacy assumptions: primary I/O is voice; the on-screen transcript is secondary.
This is no longer a hackathon demo — it is being built for real users.

## Current repo map (do not restructure)
- `api/` — flat FastAPI stack: main.py (routes), sarvam.py (Sarvam SDK wrapper:
  Saaras STT / Bulbul TTS / Vision OCR / chat), agent.py (voice router),
  voice_ws.py (/ws/voice persistent sessions + progressive audio + barge-in cancel),
  ocr.py (OCR routing), doc_retrieve.py (keyword chunking for doc QA),
  db.py (SQLite), auth.py (guest + magic link), rate_limit.py, cache/ (runtime).
- `web/` — Next.js PWA: app/page.tsx (whole UI — KEEP the design), SetuOrb,
  lib/voice-session.ts (WS client), lib/audio/* (recorder, browser-stt, playback,
  barge-in, wav, worklet-vad), lib/session-storage.ts (IndexedDB history).
- `samples/` — demo documents (currently only Rythu Bharosa — must generalize).
- Root: render.yaml, .env, keep-api-warm cron workflow.

## Hard requirements (priority order)
- P0 Both phone browsers work. iOS Safari has NO webkitSpeechRecognition and
  suspends AudioContext without a user gesture — server STT (Saaras) and Web Audio
  unlock handling are mandatory, browser STT is only an optimization.
- P0 Persistent state survives redeploys. Render free tier = ephemeral disk:
  SQLite and OCR/TTS caches MUST live on a mounted disk (or hosted DB). Today's
  data loss on restart is a primary reason "nothing works deployed."
- P0 Lifespan never blocks serving: warmup (sample OCR, TTS cache) runs in a
  background task AFTER the app responds; /health answers immediately.
- P0 Observability before behavior changes: every stage logs timings server-side
  and client-side; /debug/last-turn returns the last turn's stage-timing JSON.
  Capture one real phone session's logs before touching pipeline logic.
- P0 Voice-native onboarding: user speaks their language ("I speak Telugu") →
  session.language is set → intro plays IN that language. No popups, no pickers.
- P0 Continuous hands-free loop: after Setu finishes speaking, mic reopens
  automatically. No tap per turn. ~30s silence → soft "I'm still here" prompt.
- P1 Barge-in: user speaks during TTS → audio stops immediately, interruption is
  treated as the new turn. Echo-guarded (300ms grace + echoCancellation).
- P0 Every turn (user + Setu, text + language) persisted instantly; reopening an
  old chat restores transcript + doc text + language WITHOUT re-running OCR and
  WITHOUT resending full doc text to the LLM on non-doc turns.
- P0 Document answers fail closed: quoted line not in OCR text → not_found/abstain,
  spoken as "this isn't in the document." Never invent a notice.
- P0 No silent failures: STT fail → localized "say again"; OCR unclear → localized
  "retake in better light"; API/credit failure → localized apology + visible banner.

## Stack (Sarvam only — do not add providers)
- STT: Saaras v3 (model="saaras:v3"; use codemix-tolerant transcription — real
  users mix languages mid-sentence).
- TTS: Bulbul v3 (bulbul:v3). Bulbul v4 is announced but not yet the documented
  API model — treat as a future drop-in upgrade.
- OCR: Sarvam Vision (₹0.5/page). Cache by content hash; repeat scans are free.
- LLM: sarvam-105b for answers; sarvam-30b for routing/classification/summaries.
- Backend: FastAPI flat folder, uvicorn. Frontend: Next.js PWA (UI design stays).
- Storage: SQLite on a mounted disk via DB_PATH env (or hosted Postgres later).

## Voice turn pipeline (target, mostly built — needs hardening)
mic audio → Saaras STT (browser STT only if available as optimization)
→ agent.py router: regex fast path first (greeting / language switch / scan /
doc question / ack), else sarvam-30b classifier → 105b short reply (1-2 spoken
sentences; doc answers grounded in retrieved chunks + quote verification)
→ persist turn → Bulbul TTS (streamed parts over /ws/voice; REST /voice as
fallback) → playback → auto-relisten. Barge-in cancels in-flight audio anytime.

## Language routing
- session.language is the single source of truth, set by the first utterance
  (Saaras language_code + explicit language-word match, codemix tolerant).
- Mid-chat switch: "speak in English" → update session, ack in the NEW language.
- Launch languages: Telugu, Hindi, English + Bulbul v3's other 8 (Tamil, Kannada,
  Malayalam, Marathi, Bengali, Gujarati, Punjabi, Odia).

## Memory model (light, token-cheap)
- Within session: last ~8 turns verbatim + rolling 2-sentence summary (30b,
  refreshed every ~6 turns).
- Doc text enters the prompt ONLY when the routed intent is doc-related.
- Across sessions: per-user digest of last ~4 chats (title, doc name, 1-line
  summary) — injected only when the user asks about past chats.
- Resume cost = one normal turn. Never re-scan, never replay full transcripts.

## Document flow
- Scan once per document: store doc_id, OCR text, pages, content hash, owner.
- Rythu Bharosa is REMOVED as a special case. /samples = configurable generic set
  (govt notice, bank letter, prescription), same pre-cache mechanism.
- After scan: SPEAK a 2-sentence summary (what it is, one key fact, "what would
  you like to know?"), then continue the normal voice loop with doc context.

## Non-goals this iteration
- No new providers, no LiveKit, no wake word, no packaging/monorepo restructure.
- No UI redesign. No email gate (guest X-User-Id first; magic link optional).
- WS path exists — harden it (reconnect, iOS unlock, barge-in tuning);
  no new transport protocols.

## Definition of done (run before calling anything fixed)
- Android Chrome AND iPhone Safari, on the deployed URL: language pick by voice →
  5+ free-chat turns → scan a real Telugu notice photo → 3 doc questions →
  interrupt one reply → close tab → reopen chat from history → continue by voice.
  Zero taps after session start except the scan.
- Render restart → old chats still resume with context intact.
- First turn after idle < 5s with a visible "waking up" state, never dead air.
- scripts/smoke.py passes end-to-end against the deployed backend with timings.