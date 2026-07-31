/** Browser Web Speech API — free Indic STT (Chrome). OpenRouter Whisper needs credits. */

import { debugLog } from "@/lib/debug";
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

function recognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as Window & {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export function browserSttSupported(): boolean {
  return Boolean(recognitionCtor());
}

export type BrowserSttSession = {
  stop: () => Promise<string>;
  abort: () => void;
};

/** Start continuous recognition for the active language; call stop() when mic ends. */
export function startBrowserStt(language: Language): BrowserSttSession | null {
  const Ctor = recognitionCtor();
  if (!Ctor) return null;

  let finalText = "";
  let interim = "";
  let settled = false;
  let resolveStop: ((text: string) => void) | null = null;

  const recognition = new Ctor();
  recognition.lang = BCP47[language] || "en-IN";
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  recognition.onresult = (event) => {
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
  };

  recognition.onerror = (event) => {
    debugLog("[browser-stt] error", event.error);
  };

  recognition.onend = () => {
    if (settled) return;
    settled = true;
    const text = (finalText || interim).trim();
    resolveStop?.(text);
    resolveStop = null;
  };

  try {
    recognition.start();
  } catch (error) {
    debugLog("[browser-stt] start failed", error);
    return null;
  }

  return {
    stop: () =>
      new Promise((resolve) => {
        if (settled) {
          resolve((finalText || interim).trim());
          return;
        }
        resolveStop = resolve;
        try {
          recognition.stop();
        } catch {
          settled = true;
          resolve((finalText || interim).trim());
        }
        window.setTimeout(() => {
          if (!settled) {
            settled = true;
            resolve((finalText || interim).trim());
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
