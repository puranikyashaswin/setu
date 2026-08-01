/** Pure NDJSON scan-event helpers (testable; no React). */

export type ScanOutcome = "idle" | "analyzing" | "done" | "timeout" | "error" | "unclear";

export type ScanUiState = {
  analyzing: boolean;
  outcome: ScanOutcome;
  docId: string | null;
  detail: string | null;
  pages?: number;
  cached?: boolean;
  stage?: string;
  percent?: number;
};

export function initialScanUiState(): ScanUiState {
  return {
    analyzing: false,
    outcome: "idle",
    docId: null,
    detail: null,
  };
}

export function parseScanNdjsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const event = JSON.parse(trimmed) as Record<string, unknown>;
    return event && typeof event === "object" ? event : null;
  } catch {
    return null;
  }
}

/** Apply one /scan NDJSON event. Always clears analyzing on terminal events. */
export function applyScanEvent(
  state: ScanUiState,
  event: Record<string, unknown>,
): ScanUiState {
  const type = String(event.type || "");
  if (type === "progress") {
    return {
      ...state,
      analyzing: true,
      outcome: "analyzing",
      stage: typeof event.stage === "string" ? event.stage : state.stage,
      percent: typeof event.percent === "number" ? event.percent : state.percent,
      detail: typeof event.message === "string" ? event.message : state.detail,
    };
  }
  if (type === "done") {
    return {
      analyzing: false,
      outcome: "done",
      docId: event.doc_id != null ? String(event.doc_id) : null,
      detail: null,
      pages: typeof event.pages === "number" ? event.pages : undefined,
      cached: typeof event.cached === "boolean" ? event.cached : undefined,
      stage: "done",
      percent: 100,
    };
  }
  if (type === "timeout") {
    return {
      analyzing: false,
      outcome: "timeout",
      docId: event.doc_id != null ? String(event.doc_id) : null,
      detail:
        typeof event.detail === "string" && event.detail
          ? event.detail
          : "Document analysis is taking too long. Please retry with a clearer photo.",
      stage: "timeout",
    };
  }
  if (type === "error") {
    return {
      analyzing: false,
      outcome: "error",
      docId: event.doc_id != null ? String(event.doc_id) : null,
      detail:
        typeof event.detail === "string" && event.detail
          ? event.detail
          : "Document analysis failed. Please retry with a clearer photo.",
      stage: "error",
    };
  }
  if (type === "unclear_scan") {
    return {
      analyzing: false,
      outcome: "unclear",
      docId: null,
      detail: "Could not read that document clearly.",
      stage: "unclear",
    };
  }
  return state;
}

export function reduceScanNdjson(
  text: string,
  start: ScanUiState = initialScanUiState(),
): ScanUiState {
  let state = start;
  for (const line of text.split("\n")) {
    const event = parseScanNdjsonLine(line);
    if (event) state = applyScanEvent(state, event);
  }
  return state;
}
