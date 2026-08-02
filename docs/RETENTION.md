# Data retention

| Data | Where | Retention |
|------|--------|-----------|
| Chat turns + language | SQLite `DB_PATH` | Until user deletes the chat or account |
| Document OCR text | SQLite `documents` | Until user deletes account / owning session flow |
| OCR/TTS disk cache | `CACHE_PATH` | Cache; safe to wipe (recomputable) |
| Mic audio | In-memory / turn upload | Not stored as files after the turn completes |
| Magic-link tokens | SQLite | Expire in 30 minutes |
| Client debug ring | `sessionStorage` | Cleared with the tab / explicit clear |

Audio bytes are processed for STT/TTS and are not kept as a long-term archive.
