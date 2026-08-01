/** Single audio owner — assistant TTS is the only audible output while speaking. */

export type PlaybackOutcome = "natural" | "interrupted" | "cancelled" | "error";

type EffectHandle = { name: string; stop: () => void };
type OwnerLog = (event: string, data: Record<string, unknown>) => void;

let assistantSpeaking = false;
let ttsVolume = 1.0;
const effectHandles: EffectHandle[] = [];
const finalizedTurns = new Set<number>();
const effectTimers = new Set<number>();
let ownerLog: OwnerLog = () => undefined;

/** Optional hook for voiceClientLog — keeps this module free of path-alias imports. */
export function setAudioOwnerLogger(fn: OwnerLog): void {
  ownerLog = fn;
}

export function isAssistantSpeaking(): boolean {
  return assistantSpeaking;
}

export function getTtsVolume(): number {
  return ttsVolume;
}

/** Mark TTS as the sole audible owner. Volume is always 1.0 — never ducked. */
export function beginAssistantTts(turnId: number): void {
  stopNonTtsAudio("tts_start");
  assistantSpeaking = true;
  ttsVolume = 1.0;
  console.info(`[audio] tts_volume=${ttsVolume} turn_id=${turnId}`);
  ownerLog("audio", {
    tts_volume: ttsVolume,
    turn_id: turnId,
    reason: "tts_start",
  });
}

export function endAssistantTts(): void {
  assistantSpeaking = false;
}

/**
 * Stop/disconnect every legacy effect node/timer.
 * Harmless no-op when none are registered (effects disabled this release).
 */
export function stopNonTtsAudio(reason: string): number {
  const count = effectHandles.length + effectTimers.size;
  while (effectHandles.length) {
    const handle = effectHandles.pop();
    try {
      handle?.stop();
    } catch {
      /* ignore */
    }
  }
  for (const id of effectTimers) {
    window.clearInterval(id);
    window.clearTimeout(id);
  }
  effectTimers.clear();
  console.info(`[audio] non_tts_stopped count=${count} reason=${reason}`);
  ownerLog("audio", { non_tts_stopped: count, reason });
  return count;
}

/** Register a non-TTS effect so stopNonTtsAudio can kill it. Blocked while speaking. */
export function registerNonTtsEffect(name: string, stop: () => void): boolean {
  if (assistantSpeaking) {
    console.info(`[audio] unexpected_non_tts_attempt name=${name} blocked=true`);
    ownerLog("audio", { unexpected_non_tts_attempt: name, blocked: true });
    try {
      stop();
    } catch {
      /* ignore */
    }
    return false;
  }
  effectHandles.push({ name, stop });
  return true;
}

export function registerNonTtsTimer(id: number): void {
  effectTimers.add(id);
}

/**
 * Gate any non-TTS sound. This release disables all effects — always returns false
 * (blocked). Logs when attempted during speaking.
 */
export function attemptNonTtsSound(name: string): boolean {
  console.info(`[audio] unexpected_non_tts_attempt name=${name} blocked=true`);
  ownerLog("audio", {
    unexpected_non_tts_attempt: name,
    blocked: true,
    speaking: assistantSpeaking,
  });
  return false;
}

/**
 * Settle a playback turn exactly once. Returns false if already finalized.
 */
export function finalizePlayback(
  turnId: number,
  outcome: PlaybackOutcome,
): boolean {
  if (finalizedTurns.has(turnId)) {
    ownerLog("playback_finalize_skipped", { turn_id: turnId, outcome });
    return false;
  }
  finalizedTurns.add(turnId);
  // Bound memory for long sessions.
  if (finalizedTurns.size > 200) {
    const first = finalizedTurns.values().next().value;
    if (first != null) finalizedTurns.delete(first);
  }
  assistantSpeaking = false;
  ownerLog("playback_finalize", { turn_id: turnId, outcome });
  console.info(`[audio] tts_volume=${ttsVolume} turn_id=${turnId} outcome=${outcome}`);
  return true;
}

/** Test helper */
export function __resetAudioOwnerForTests(): void {
  assistantSpeaking = false;
  ttsVolume = 1.0;
  effectHandles.length = 0;
  effectTimers.clear();
  finalizedTurns.clear();
}
