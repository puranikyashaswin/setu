"use client";

import { useEffect } from "react";
import { shouldPromptStillHere, stillHerePhrase } from "./still-here";

/** Soft “I'm still here” after ~30s of continuous listening with no turn submit. */
export function useStillHerePrompt(
  isRecording: boolean,
  language: string,
  setStatusText: (text: string) => void,
  log: (event: string, data: Record<string, unknown>) => void,
): void {
  useEffect(() => {
    if (!isRecording) return;
    const startedAt = Date.now();
    let prompted = false;
    const id = window.setInterval(() => {
      const decision = shouldPromptStillHere({
        listening: true,
        idleMs: Date.now() - startedAt,
        alreadyPrompted: prompted,
      });
      if (!decision.prompt) return;
      prompted = true;
      setStatusText(stillHerePhrase(language));
      log("still_here_prompt", { language });
    }, 1000);
    return () => window.clearInterval(id);
  }, [isRecording, language, setStatusText, log]);
}
