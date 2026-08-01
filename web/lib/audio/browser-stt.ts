/** Browser Web Speech API — optional early feedback. Server Saaras STT is authoritative. */

import { debugLog, voiceClientLog } from "@/lib/debug";
import type { Language } from "@/lib/types";

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
};

type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    0: { transcript: string };
  }>;
};

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

const BCP47: Record<Language, string> = {
  te: "te-IN",
  hi: "hi-IN",
  en: "en-IN",
  mr: "mr-IN",
  ta: "ta-IN",
  kn: "kn-IN",
  bn: "bn-IN",
  gu: "gu-IN",
  ml: "ml-IN",
  pa: "pa-IN",
  or: "or-IN",
};

const UNAVAILABLE_ERRORS = new Set([
  "service-not-allowed",
  "not-allowed",
  "network",
  "aborted",
]);

/** Soft-disable after a fatal browser-STT failure for this page load. */
let browserSttDisabled = false;

export function isBrowserSttUnavailableError(error?: string | null): boolean {
  return UNAVAILABLE_ERRORS.has((error || "").toLowerCase());
}

function recognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as Window & {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export function browserSttSupported(): boolean {
  return !browserSttDisabled && Boolean(recognitionCtor());
}

export type BrowserSttSession = {
  stop: () => Promise<string>;
  abort: () => void;
  /** True when browser STT hit a non-fatal-for-pipeline unavailable error. */
  unavailable: () => boolean;
};

/** Start continuous recognition for the active language; call stop() when mic ends.
 *  onInterim (optional, server_vad_v1 semantic hint only): fired on every interim/final
 *  browser transcript update. Display-only — never a finalization authority. */
export function startBrowserStt(language: Language, onInterim?: (text: string) => void): BrowserSttSession | null {
  if (browserSttDisabled) return null;
  const Ctor = recognitionCtor();
  if (!Ctor) return null;

  let finalText = "";
  let interim = "";
  let settled = false;
  let unavailable = false;
  let resolveStop: ((text: string) => void) | null = null;

  const recognition = new Ctor();
  recognition.lang = BCP47[language] || "en-IN";
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  recognition.onresult = (event) => {
    if (unavailable) return;
    let interimChunk = "";
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const piece = event.results[i]?.[0]?.transcript || "";
      if (event.results[i]?.isFinal) {
        finalText = `${finalText} ${piece}`.trim();
      } else {
        interimChunk += piece;
      }
    }
    interim = interimChunk.trim();
    const display = (finalText || interim).trim();
    if (display) onInterim?.(display);
  };

  recognition.onerror = (event) => {
    const err = event.error || "unknown";
    debugLog("[browser-stt] error", err);
    if (isBrowserSttUnavailableError(err)) {
      unavailable = true;
      browserSttDisabled = true;
      finalText = "";
      interim = "";
      voiceClientLog("ws_error", { detail: `browser_stt_unavailable:${err}` });
      try {
        recognition.abort();
      } catch {
        /* ignore */
      }
      if (!settled) {
        settled = true;
        resolveStop?.("");
        resolveStop = null;
      }
      return;
    }
    voiceClientLog("ws_error", { detail: `browser_stt:${err}` });
  };

  recognition.onend = () => {
    if (settled) return;
    settled = true;
    const text = unavailable ? "" : (finalText || interim).trim();
    resolveStop?.(text);
    resolveStop = null;
  };

  try {
    recognition.start();
  } catch (error) {
    debugLog("[browser-stt] start failed", error);
    browserSttDisabled = true;
    voiceClientLog("ws_error", { detail: "browser_stt_unavailable:start_failed" });
    return null;
  }

  return {
    unavailable: () => unavailable,
    stop: () =>
      new Promise((resolve) => {
        if (settled) {
          resolve(unavailable ? "" : (finalText || interim).trim());
          return;
        }
        if (unavailable) {
          settled = true;
          resolve("");
          return;
        }
        resolveStop = resolve;
        try {
          recognition.stop();
        } catch {
          settled = true;
          resolve(unavailable ? "" : (finalText || interim).trim());
        }
        window.setTimeout(() => {
          if (!settled) {
            settled = true;
            resolve(unavailable ? "" : (finalText || interim).trim());
          }
        }, 900);
      }),
    abort: () => {
      settled = true;
      resolveStop?.("");
      resolveStop = null;
      try {
        recognition.abort();
      } catch {
        /* ignore */
      }
    },
  };
}
