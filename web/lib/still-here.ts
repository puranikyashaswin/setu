/** Soft presence prompt after long idle listening (CONTEXT ~30s). */

export const STILL_HERE_AFTER_MS = 30_000;

export type StillHereDecision =
  | { prompt: false }
  | { prompt: true; phraseKey: "still_here" };

export function shouldPromptStillHere(options: {
  listening: boolean;
  idleMs: number;
  alreadyPrompted: boolean;
}): StillHereDecision {
  if (!options.listening || options.alreadyPrompted) return { prompt: false };
  if (options.idleMs < STILL_HERE_AFTER_MS) return { prompt: false };
  return { prompt: true, phraseKey: "still_here" };
}

export function stillHerePhrase(language: string): string {
  const lang = (language || "en").toLowerCase().slice(0, 2);
  if (lang === "hi") return "मैं अभी भी यहाँ हूँ। बोलिए।";
  if (lang === "te") return "నేను ఇంకా ఉన్నాను. మాట్లాడండి.";
  if (lang === "ta") return "நான் இன்னும் இங்கே இருக்கிறேன். பேசுங்கள்.";
  return "I'm still here. Go ahead.";
}
