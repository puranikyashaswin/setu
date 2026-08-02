import { authHeaders } from "@/lib/auth";

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000").replace(/\/$/, "");

export type ApiHistoryMessage = { role: string; content: string; language?: string };

export type VoiceAskPayload = {
  answer: string;
  language: string;
  status: "verified_document" | "not_found" | "unclear_scan";
  abstain: boolean;
  all_verified: boolean;
  evidence: Array<{ page: number; quote: string; verified: boolean }>;
  corrections: Array<{ field: string; value: string; timestamp: number }>;
  action_items: string[];
  model_used?: string | null;
};

export type VoiceTurnResponse = {
  transcript: string;
  language_code?: string;
  language: string;
  route: string;
  intent: string;
  reply: string;
  spoken: string;
  open_camera: boolean;
  continue_listening: boolean;
  model_used?: string | null;
  ask?: VoiceAskPayload | null;
  audio_base64: string;
  audio_mime: string;
  audio_parts_base64?: string[];
  tools_used?: string[];
};

function withAuth(init?: HeadersInit): HeadersInit {
  return { ...authHeaders(), ...(init ?? {}) };
}

export async function postSpeak(params: {
  text: string;
  language: string;
  speaker: string;
  pace: number;
}): Promise<ArrayBuffer> {
  const response = await fetch(`${API_URL}/speak`, {
    method: "POST",
    headers: withAuth({ "Content-Type": "application/json" }),
    body: JSON.stringify(params),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(detail || `Speech unavailable (${response.status})`);
  }
  return response.arrayBuffer();
}

export async function postVoiceTurn(params: {
  audio: Blob;
  language: string;
  hasDocument: boolean;
  docId?: string | null;
  sessionId?: string | null;
  history: ApiHistoryMessage[];
  memory?: string | null;
  onboarded: boolean;
  speaker: string;
  pace: number;
  forceRoute?: string | null;
  /** Browser Web Speech transcript — skips server Whisper when set. */
  transcript?: string | null;
}): Promise<VoiceTurnResponse> {
  const form = new FormData();
  form.append("file", params.audio, "setu-question.wav");
  form.append("language", params.language);
  form.append("has_document", String(params.hasDocument));
  if (params.docId) form.append("doc_id", params.docId);
  if (params.sessionId) form.append("session_id", params.sessionId);
  form.append("history", JSON.stringify(params.history));
  if (params.memory) form.append("memory", params.memory);
  form.append("onboarded", String(params.onboarded));
  form.append("speaker", params.speaker);
  form.append("pace", String(params.pace));
  if (params.forceRoute) form.append("force_route", params.forceRoute);
  if (params.transcript?.trim()) form.append("transcript", params.transcript.trim());

  const response = await fetch(`${API_URL}/voice`, {
    method: "POST",
    headers: withAuth(),
    body: form,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (response.status === 401) throw new Error("Sign-in required — refresh and try again");
    if (response.status === 429) throw new Error("Too many requests — wait a moment");
    throw new Error(detail || "Voice turn failed");
  }
  return response.json() as Promise<VoiceTurnResponse>;
}

export async function deleteAccount(): Promise<{ ok: boolean; deleted?: Record<string, number> }> {
  const response = await fetch(`${API_URL}/auth/account`, {
    method: "DELETE",
    headers: withAuth(),
    credentials: "include",
  });
  if (!response.ok) throw new Error("Could not delete account");
  return response.json() as Promise<{ ok: boolean; deleted?: Record<string, number> }>;
}

export async function postSummarize(docId: string, language: string): Promise<{ summary: string }> {
  const response = await fetch(`${API_URL}/summarize`, {
    method: "POST",
    headers: withAuth({ "Content-Type": "application/json" }),
    body: JSON.stringify({ doc_id: docId, answer_language: language }),
  });
  if (!response.ok) {
    if (response.status === 404) throw new Error("Document expired — show it again");
    throw new Error("Summarize failed");
  }
  return response.json() as Promise<{ summary: string }>;
}

export type ScanStreamResult =
  | { kind: "done"; doc_id: string; pages?: number; cached?: boolean; preview?: string; provider?: string }
  | { kind: "unclear" }
  | { kind: "timeout"; detail: string }
  | { kind: "error"; detail: string };

export async function postScan(
  blob: Blob,
  language: string,
  onEvent: (event: Record<string, unknown>) => void,
  options?: { signal?: AbortSignal },
): Promise<ScanStreamResult> {
  const { applyScanEvent, initialScanUiState, parseScanNdjsonLine } = await import("@/lib/scan-events");
  const form = new FormData();
  form.append("file", blob, "document.jpg");
  form.append("language", `${language}-IN`);
  const response = await fetch(`${API_URL}/scan`, {
    method: "POST",
    headers: withAuth(),
    body: form,
    signal: options?.signal,
  });
  if (!response.ok || !response.body) throw new Error("Scan failed");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let state = initialScanUiState();
  let donePayload: Extract<ScanStreamResult, { kind: "done" }> | null = null;

  const handleEvent = (event: Record<string, unknown>) => {
    onEvent(event);
    state = applyScanEvent(state, event);
    if (event.type === "done") {
      donePayload = {
        kind: "done",
        doc_id: String(event.doc_id),
        pages: event.pages as number | undefined,
        cached: event.cached as boolean | undefined,
        preview: typeof event.preview === "string" ? event.preview : undefined,
        provider: typeof event.provider === "string" ? event.provider : undefined,
      };
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const event = parseScanNdjsonLine(line);
      if (event) handleEvent(event);
    }
  }
  const tail = parseScanNdjsonLine(buffer);
  if (tail) handleEvent(tail);

  if (state.outcome === "timeout") {
    return { kind: "timeout", detail: state.detail || "Document analysis is taking too long." };
  }
  if (state.outcome === "error") {
    return { kind: "error", detail: state.detail || "Scan failed" };
  }
  if (state.outcome === "unclear") return { kind: "unclear" };
  if (donePayload) return donePayload;
  throw new Error("Scan incomplete");
}
