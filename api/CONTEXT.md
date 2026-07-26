# Setu — Verified Sarvam Stack Context

All facts below were verified by direct API testing on 24 July 2026.
Do NOT rely on training data for Sarvam APIs — it is outdated.
Use ONLY the model IDs, parameters, and patterns documented here.

## Model IDs — use these EXACTLY

| Purpose | Model ID |
|---|---|
| Chat / reasoning | `sarvam-105b` |
| Speech-to-text | `saaras:v3` |
| Text-to-speech | `bulbul:v3` |
| Translation | `sarvam-translate:v1` |
| Document OCR | Sarvam Vision via `client.document_intelligence` |

## DEPRECATED — never use these
`sarvam-m`, `saarika:v1`, `saarika:v2`, `saarika:v2.5`, `saaras:v2.5`,
`bulbul:v1`, `bulbul:v2`

## Auth
```python
from sarvamai import SarvamAI
client = SarvamAI(api_subscription_key=os.getenv("SARVAM_API_KEY"))
```

## CRITICAL GOTCHAS — verified by testing

### 1. Reasoning trap (breaks silently)
Reasoning is ON by default. If max_tokens is low, reasoning consumes the entire
budget and `content` comes back EMPTY with only `reasoning_content` populated
and `finish_reason="length"`.

ALWAYS pass:
```python
reasoning_effort=None, max_tokens=4096
```

### 2. Structured output — Python SDK quirk
`response_format` must go through request_options, NOT as a top-level kwarg:
```python
client.chat.completions(
    model="sarvam-105b",
    messages=[...],
    reasoning_effort=None,
    max_tokens=4096,
    request_options={"additional_body_parameters": {
        "response_format": {"type": "json_schema", "json_schema": {...}}
    }}
)
```
Response arrives as a JSON **string** in `message.content` — always `json.loads()`.

### 3. Tool calling — verified response shape
```python
resp.choices[0].message.tool_calls[0].function.name       # str
resp.choices[0].message.tool_calls[0].function.arguments  # JSON STRING
args = json.loads(resp.choices[0].message.tool_calls[0].function.arguments)
```
`finish_reason == "tool_calls"` when a tool is invoked.

### 4. TTS speakers
Use `speaker="shubh"` — verified working for te-IN, hi-IN, en-IN.

DO NOT pass `pitch` or `loudness` — those are bulbul:v2 params, v3 rejects them.

The SDK's speaker Literal type MIXES v2 and v3 names. Autocomplete will suggest
broken values. These are v2-ONLY and will error on v3:
`anushka, abhilash, manisha, vidya, arya, karun, hitesh`

### 5. Vision file format
Vision rejects files whose extension doesn't match actual content
("Invalid or corrupted image file"). A PNG named .jpg WILL fail.
Validate real format before upload.
Accepts: PDF, PNG, JPG. Max 10 pages per job.

### 6. Vision flow
```python
job = client.document_intelligence.create_job(language=..., output_format="md")
job.upload_file(...)
job.start()
job.wait_until_complete()
job.download_output()
```

## MEASURED LATENCIES (real, from testing)

| Stage | Latency |
|---|---|
| Vision (per doc, 2 pages) | 9–14s ← THE BOTTLENECK |
| Vision (cache hit) | 0.00s |
| STT (saaras:v3) | 0.3–1.2s |
| Chat (sarvam-105b) | 0.5–3.9s |
| TTS (bulbul:v3, short text) | 1.8–3.4s |
| TTS (bulbul:v3, long paragraph) | 6.8s ← keep answers SHORT |
| Translate | 0.3–0.4s |

### Design consequences (non-negotiable)
- Run Vision at UPLOAD time, never at question time
- Cache Vision output by file SHA256 — repeat questions must be instant
- Pre-cache all demo documents at startup
- Keep spoken answers to 2 sentences max; show full detail on screen only
- Target: <5s per question after document is cached

## Saaras v3 modes
`transcribe` | `translate` | `verbatim` | `translit` | `codemix`

Verified: `codemix` keeps English words in Latin script inside Indic sentences.
On pure-Indic or pure-English audio it matches `transcribe`.
Use `codemix` for user questions.

Returns `language_code` and `language_probability`.

## Rate limits
- Vision Document Digitization: **10 req/min, ALL plans** (no upgrade path)
- Vision real-time: 30 req/min
- sarvam-105b: 40 req/min (Starter)
- Add exponential backoff on 429 and 503

## ANSWER CONTRACT

Every /ask response must match this schema exactly:
```json
{
  "answer": "natural sentence in the user's language — NEVER a machine string",
  "language": "te",
  "status": "verified_document | not_found | unclear_scan",
  "action_items": ["..."],
  "evidence": [{"page": 1, "quote": "exact text from the document"}],
  "abstain": false
}
```

### System prompt requirements — STRICT
1. Answer ONLY from the provided document text. Never use outside knowledge.
2. If the document does not contain what was SPECIFICALLY asked, set
   `status="not_found"` and `abstain=true`. Do NOT silently answer a related
   or adjacent question instead. (Verified failure mode: asked for "last date",
   model answered about "start date" and marked it verified.)
3. When abstaining, `answer` must still be a natural sentence in the user's
   language explaining what is missing and what IS available.
4. Every `evidence.quote` must be verbatim from the document text.
5. Keep `answer` short enough to speak aloud in ~2 sentences.

### Citation verification (required)
After every /ask, verify each `evidence.quote` appears as a substring of the
Vision-extracted text. Normalize whitespace and newlines before comparing —
Vision inserts line breaks mid-sentence. Reject or flag unverified quotes.

## Deployment
- Single FastAPI service, serves its own frontend via StaticFiles
- One origin — no CORS
- Deploy to Railway, HTTPS required for getUserMedia
- Never split frontend/backend across origins

## Browser constraints
- `getUserMedia` requires HTTPS
- iOS Safari: audio playback requires a user gesture
- Record audio as WAV/PCM — avoid opus, iOS Safari breaks on it
- Always keep upload as a fallback if camera/mic permission is denied