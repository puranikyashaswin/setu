/**
 * Adaptive utterance endpoint detection — separate from speech-start.
 *
 * Speech-start stays on the raw 24-frame threshold crossing (recorder.ts).
 * Speech-end uses an ambient-aware, peak-aware silence floor applied to a
 * smoothed energy EMA, so ordinary room hum (~0.02–0.03 RMS) never keeps a
 * turn alive until the 15s max_recording cap.
 */

export const ENDPOINT_SILENCE_MS = 850;
export const ENDPOINT_RELATIVE_DROP_MS = 1000;
export const ENDPOINT_MIN_AFTER_SPEECH_MS = 900;
export const ENDPOINT_POST_SPEECH_FALLBACK_MS = 4500;
export const SILENCE_FLOOR_MIN = 0.006;
export const SILENCE_FLOOR_MAX = 0.06;
/** Time constant for the smoothed speech-energy EMA. */
export const SPEECH_ENERGY_WINDOW_MS = 100;
/** EMA step for ambient baseline while frames are quiet. */
export const AMBIENT_EMA_ALPHA = 0.05;

export type EndpointReason = "primary" | "relative_drop" | "post_speech_fallback";

export type EndpointDecision = {
  reason: EndpointReason;
  silenceMs: number;
  silenceFloor: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Silence floor derived from BOTH the pre-speech ambient baseline and the speech peak. */
export function computeEndpointSilenceFloor(ambientBaseline: number, speechPeak: number): number {
  const raw = Math.max(
    ambientBaseline * 1.25,
    Math.min(speechPeak * 0.2, ambientBaseline * 2.5),
  );
  return Number(clamp(raw, SILENCE_FLOOR_MIN, SILENCE_FLOOR_MAX).toFixed(4));
}

/** Relative-drop ceiling: energy below this counts as "dropped toward ambient". */
export function computeRelativeDropCeiling(ambientBaseline: number, speechPeak: number): number {
  return Math.max(ambientBaseline * 1.35, speechPeak * 0.35);
}

export class EndpointDetector {
  ambientBaseline: number;
  speechPeak = 0;
  smoothedEnergy = 0;
  confirmedSpeech = false;
  private confirmedAtMs = 0;
  private lastMeaningfulSpeechMs = 0;
  private silentSinceMs: number | null = null;
  private dropSinceMs: number | null = null;
  private lastFrameMs: number | null = null;
  private smoothingInitialized = false;

  constructor(options: { ambientBaseline: number }) {
    this.ambientBaseline = options.ambientBaseline;
  }

  /** Recorder calls this when its existing 24-frame speech-start confirms. */
  noteSpeechConfirmed(nowMs: number): void {
    if (this.confirmedSpeech) return;
    this.confirmedSpeech = true;
    this.confirmedAtMs = nowMs;
    this.lastMeaningfulSpeechMs = nowMs;
    this.silentSinceMs = null;
    this.dropSinceMs = null;
  }

  get silenceFloor(): number {
    return computeEndpointSilenceFloor(this.ambientBaseline, Math.max(this.speechPeak, this.ambientBaseline));
  }

  /** Silence progress 0..1 for UI; 0 when no silence streak. */
  get silenceProgress(): number {
    if (this.silentSinceMs == null || this.lastFrameMs == null) return 0;
    return Math.min(1, (this.lastFrameMs - this.silentSinceMs) / ENDPOINT_SILENCE_MS);
  }

  get silenceMs(): number {
    if (this.silentSinceMs == null || this.lastFrameMs == null) return 0;
    return Math.max(0, this.lastFrameMs - this.silentSinceMs);
  }

  /**
   * Feed one worklet frame. Returns an EndpointDecision exactly once per turn
   * (caller stops feeding after a decision).
   */
  onFrame(rms: number, nowMs: number, speechThreshold: number): EndpointDecision | null {
    const dtMs = this.lastFrameMs == null ? 0 : Math.min(50, Math.max(0, nowMs - this.lastFrameMs));
    this.lastFrameMs = nowMs;
    if (!this.smoothingInitialized) {
      this.smoothingInitialized = true;
      this.smoothedEnergy = rms;
    } else {
      const alpha = 1 - Math.exp(-dtMs / SPEECH_ENERGY_WINDOW_MS);
      this.smoothedEnergy += alpha * (rms - this.smoothedEnergy);
    }

    if (!this.confirmedSpeech) {
      // Pre-speech: track ambient only from quiet frames.
      if (rms < speechThreshold) {
        this.ambientBaseline += AMBIENT_EMA_ALPHA * (rms - this.ambientBaseline);
      }
      return null;
    }

    if (rms > this.speechPeak) this.speechPeak = rms;
    if (rms >= speechThreshold) this.lastMeaningfulSpeechMs = nowMs;

    const floor = this.silenceFloor;
    // Ambient adapts only during frames that are confirmed silence.
    if (this.smoothedEnergy < floor) {
      this.ambientBaseline += AMBIENT_EMA_ALPHA * (Math.min(rms, floor) - this.ambientBaseline);
    }

    // Never endpoint during the first 900ms after confirmed speech begins.
    if (nowMs - this.confirmedAtMs < ENDPOINT_MIN_AFTER_SPEECH_MS) {
      this.silentSinceMs = null;
      this.dropSinceMs = null;
      return null;
    }

    if (this.smoothedEnergy < floor) {
      if (this.silentSinceMs == null) this.silentSinceMs = nowMs;
      const silenceMs = nowMs - this.silentSinceMs;
      if (silenceMs >= ENDPOINT_SILENCE_MS) {
        return { reason: "primary", silenceMs, silenceFloor: floor };
      }
    } else {
      this.silentSinceMs = null;
    }

    const dropCeiling = computeRelativeDropCeiling(this.ambientBaseline, this.speechPeak);
    if (this.smoothedEnergy <= dropCeiling) {
      if (this.dropSinceMs == null) this.dropSinceMs = nowMs;
      const silenceMs = nowMs - this.dropSinceMs;
      if (silenceMs >= ENDPOINT_RELATIVE_DROP_MS) {
        return { reason: "relative_drop", silenceMs, silenceFloor: floor };
      }
    } else {
      this.dropSinceMs = null;
    }

    if (nowMs - this.lastMeaningfulSpeechMs > ENDPOINT_POST_SPEECH_FALLBACK_MS) {
      return {
        reason: "post_speech_fallback",
        silenceMs: nowMs - this.lastMeaningfulSpeechMs,
        silenceFloor: floor,
      };
    }

    return null;
  }
}
