/** Relative ambient-derived VAD threshold — quiet mics must be able to cross it. */

export const VAD_THRESHOLD_FLOOR = 0.006;
export const VAD_THRESHOLD_CAP = 0.012;
/** Ambient at or above this skips the cap (genuinely loud environment). */
export const VAD_AMBIENT_LOUD_RMS = 0.007;
export const VAD_DELTA_WEAK_RATIO = 1.5;

export function computeSpeechThreshold(ambientRms: number): number {
  const raw = Math.max(VAD_THRESHOLD_FLOOR, ambientRms * 1.8);
  const threshold = ambientRms >= VAD_AMBIENT_LOUD_RMS ? raw : Math.min(raw, VAD_THRESHOLD_CAP);
  return Number(threshold.toFixed(4));
}

export function shouldDeltaWeakTrigger(ambientRms: number, rmsMax: number, threshold: number): boolean {
  return rmsMax < threshold && rmsMax > VAD_DELTA_WEAK_RATIO * ambientRms;
}

/** Peak-relative silence floor for utterance endpointing (not speech-start). */
export const SILENCE_PEAK_RATIO = 0.25;

export function computeSilenceFloor(peakRms: number): number {
  return Number(Math.max(VAD_THRESHOLD_FLOOR, peakRms * SILENCE_PEAK_RATIO).toFixed(4));
}

/** True when RMS is below the peak-relative silence floor. */
export function isSilenceRelativeToPeak(rms: number, peakRms: number): boolean {
  return rms < computeSilenceFloor(peakRms);
}

export type UtteranceWindowOutcome = "continue" | "no_speech" | "delta_weak";

/** End-of-window decision when no confirmed speech yet (testable). */
export function resolveNoSpeechOutcome(options: {
  heardSpeech: boolean;
  elapsedMs: number;
  noSpeechMs: number;
  ambientRms: number;
  rmsMax: number;
  threshold: number;
}): UtteranceWindowOutcome {
  if (options.heardSpeech) return "continue";
  if (options.elapsedMs < options.noSpeechMs) return "continue";
  if (shouldDeltaWeakTrigger(options.ambientRms, options.rmsMax, options.threshold)) {
    return "delta_weak";
  }
  return "no_speech";
}
