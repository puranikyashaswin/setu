/**
 * Authoritative per-turn endpoint owner — close-talk voice gate.
 *
 * Goal: listen for the person holding the phone (loud, bursty, near-mic speech),
 * ignore fans / room tone / distant chatter, and only finalize after they stop.
 *
 * Adaptive noise-floor + close-talk onset:
 *   noiseFloor — first ~400ms + continuous non-speech tracking
 *   onset      — smoothedRms > max(CLOSE_TALK_ABSOLUTE, noiseFloor × CLOSE_TALK_SNR)
 *                sustained ≥ ONSET_HOLD_MS with bursty variance (rejects steady noise
 *                and far-away talk that never reaches close-talk level)
 *   speechPeak — latched max RMS after confirm; distant voices below ~32% of peak
 *                do not keep the turn alive
 *   quietCeiling = max(noiseFloor × 1.5, speechPeak × PEAK_QUIET_RATIO)
 *                so the turn ends when YOU stop, even if the room is a bit chatty
 *   post_speech_quiet — below quietCeiling for QUIET_AFTER_SPEECH_MS
 *   last_speech_gap   — safety if energy stays in the mid band
 *   max_recording — emergency only
 */

import { voiceClientLog } from "@/lib/debug";

/** Wait this long after the user stops before submitting the turn. */
export const QUIET_AFTER_SPEECH_MS = 1000;
export const LAST_SPEECH_GAP_MS = 2500;
export const MIN_AFTER_CONFIRM_MS = 1200;
/** Calibrate noise floor from the first ~400ms of each recording. */
export const NOISE_FLOOR_WINDOW_MS = 400;
export const SMOOTH_WINDOW_MS = 100;
/** End turn when RMS falls back near noise_floor × this. */
export const QUIET_NOISE_MULT = 1.5;
export const QUIET_ABSOLUTE_FLOOR = 0.008;

/**
 * Close-talk SNR — phone-near speech is typically ≥4–5× room tone.
 * Distant other speakers usually sit at ~1.5–3× and are rejected.
 */
export const CLOSE_TALK_SNR = 4.5;
/** Minimum absolute level for “speaking into the phone”. */
export const CLOSE_TALK_ABSOLUTE = 0.022;
/** @deprecated alias — onset uses close-talk gates */
export const ONSET_SNR = CLOSE_TALK_SNR;
/** @deprecated alias */
export const ONSET_ABSOLUTE_FLOOR = CLOSE_TALK_ABSOLUTE;

export const ONSET_HOLD_MS = 280;
export const ONSET_VARIANCE_WINDOW_MS = 280;
export const ONSET_MIN_VARIANCE = 0.000008;

/** After confirm: energy below this fraction of peak is not “still you speaking”. */
export const SPEECH_PEAK_MEANINGFUL_RATIO = 0.35;
/** Quiet if below this fraction of your peak (even with mild room chatter). */
export const SPEECH_PEAK_QUIET_RATIO = 0.28;

export const MEANINGFUL_NOISE_MULT = 2.2;
export const MEANINGFUL_ABSOLUTE_FLOOR = 0.018;

/** @deprecated Use NOISE_FLOOR_WINDOW_MS */
export const AMBIENT_WINDOW_MS = NOISE_FLOOR_WINDOW_MS;
/** @deprecated Use QUIET_NOISE_MULT */
export const QUIET_AMBIENT_MULT = QUIET_NOISE_MULT;
/** @deprecated */
export const QUIET_RMS_FLOOR = QUIET_ABSOLUTE_FLOOR;
/** @deprecated */
export const MEANINGFUL_AMBIENT_MULT = MEANINGFUL_NOISE_MULT;
/** @deprecated */
export const MEANINGFUL_RMS_FLOOR = MEANINGFUL_ABSOLUTE_FLOOR;

export type EndpointReason = "post_speech_quiet" | "last_speech_gap" | "max_recording";
export type OnsetRejectedReason =
  | "below_snr"
  | "steady_noise"
  | "hold_incomplete"
  | "far_talk";

type ActiveTurn = { turnId: number; generation: number };
let activeTurn: ActiveTurn | null = null;
let generationCounter = 0;

/** Test helper — clears the generation token between tests. */
export function __resetEndpointTurnForTests(): void {
  activeTurn = null;
}

export class TurnEndpoint {
  readonly turnId: number;
  private readonly generation: number;
  private readonly onFinish: (reason: EndpointReason) => void;

  startedAtMs = 0;
  ambientBaseline = 0;
  smoothedRms = 0;
  confirmedSpeech = false;
  finished = false;
  lastOnsetRejectedReason: OnsetRejectedReason | null = null;
  lastOnsetSnr = 0;
  /** Peak RMS of the confirmed close-talk utterance. */
  speechPeakRms = 0;

  private ambientSum = 0;
  private ambientCount = 0;
  private firstFrameAtMs: number | null = null;
  lastFrameAtMs: number | null = null;
  private smoothingInitialized = false;
  confirmedAtMs = 0;
  private quietSinceMs: number | null = null;
  private lastMeaningfulSpeechAtMs = 0;

  private onsetAboveSinceMs: number | null = null;
  private onsetPeakRms = 0;
  private recentRms: Array<{ t: number; rms: number }> = [];
  private lastNoiseFloorLogAt = 0;
  private sawOnsetBurst = false;

  constructor(turnId: number, onFinish: (reason: EndpointReason) => void) {
    this.turnId = turnId;
    this.onFinish = onFinish;
    generationCounter += 1;
    activeTurn = { turnId, generation: generationCounter };
    this.generation = generationCounter;
  }

  private isCurrent(): boolean {
    return activeTurn?.generation === this.generation;
  }

  invalidate(): void {
    if (this.isCurrent()) activeTurn = null;
  }

  get noiseFloor(): number {
    return this.ambientBaseline;
  }

  get quietCeiling(): number {
    const noiseQuiet = Math.max(this.ambientBaseline * QUIET_NOISE_MULT, QUIET_ABSOLUTE_FLOOR);
    if (!this.confirmedSpeech || this.speechPeakRms <= 0) return noiseQuiet;
    // Higher of noise-relative and peak-relative: easier to end once YOU drop off.
    return Math.max(noiseQuiet, this.speechPeakRms * SPEECH_PEAK_QUIET_RATIO);
  }

  get onsetFloor(): number {
    return Math.max(CLOSE_TALK_ABSOLUTE, this.ambientBaseline * CLOSE_TALK_SNR);
  }

  private get meaningfulFloor(): number {
    return Math.max(
      this.ambientBaseline * MEANINGFUL_NOISE_MULT,
      MEANINGFUL_ABSOLUTE_FLOOR,
      this.speechPeakRms * SPEECH_PEAK_MEANINGFUL_RATIO,
    );
  }

  quietMs(nowMs: number): number {
    return this.quietSinceMs == null ? 0 : Math.max(0, nowMs - this.quietSinceMs);
  }

  sinceLastMeaningfulSpeechMs(nowMs: number): number {
    if (!this.confirmedSpeech) return 0;
    return Math.max(0, nowMs - this.lastMeaningfulSpeechAtMs);
  }

  quietProgress(nowMs: number): number {
    return Math.min(1, this.quietMs(nowMs) / QUIET_AFTER_SPEECH_MS);
  }

  noteSpeechConfirmed(nowMs: number): void {
    if (this.confirmedSpeech) return;
    this.confirmedSpeech = true;
    this.confirmedAtMs = nowMs;
    this.lastMeaningfulSpeechAtMs = nowMs;
    this.quietSinceMs = null;
    this.onsetAboveSinceMs = null;
    if (this.ambientCount > 0) this.ambientBaseline = this.ambientSum / this.ambientCount;
    this.speechPeakRms = Math.max(this.speechPeakRms, this.onsetPeakRms, this.smoothedRms);
    this.logNoiseFloor(nowMs, "confirmed");
  }

  private updateNoiseFloor(rms: number, nowMs: number): void {
    if (this.firstFrameAtMs == null) return;
    const inCalibration = nowMs - this.firstFrameAtMs <= NOISE_FLOOR_WINDOW_MS;
    const spikeCap = this.ambientCount === 0
      ? Infinity
      : Math.max(this.ambientBaseline * 1.8, this.ambientBaseline + 0.01, 0.015);
    if (rms > spikeCap) return;

    if (inCalibration || this.ambientCount < 8) {
      this.ambientSum += rms;
      this.ambientCount += 1;
      this.ambientBaseline = this.ambientSum / this.ambientCount;
      return;
    }
    if (this.confirmedSpeech) return;
    if (rms > this.ambientBaseline * 1.35) return;
    const alpha = 0.08;
    this.ambientBaseline += alpha * (rms - this.ambientBaseline);
    this.ambientSum = this.ambientBaseline * this.ambientCount;
  }

  private pushRecentRms(rms: number, nowMs: number): void {
    this.recentRms.push({ t: nowMs, rms });
    const cutoff = nowMs - ONSET_VARIANCE_WINDOW_MS;
    while (this.recentRms.length && this.recentRms[0]!.t < cutoff) {
      this.recentRms.shift();
    }
  }

  private rmsVariance(): number {
    if (this.recentRms.length < 4) return 0;
    const values = this.recentRms.map((r) => r.rms);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  }

  private tryConfirmSpeech(rms: number, nowMs: number): void {
    const floor = this.onsetFloor;
    const snr = this.ambientBaseline > 1e-9 ? this.smoothedRms / this.ambientBaseline : 0;
    this.lastOnsetSnr = Number(snr.toFixed(3));
    const above = this.smoothedRms > floor;
    const variance = this.rmsVariance();
    if (variance >= ONSET_MIN_VARIANCE) this.sawOnsetBurst = true;
    if (above) this.onsetPeakRms = Math.max(this.onsetPeakRms, rms, this.smoothedRms);

    if (!above) {
      this.onsetAboveSinceMs = null;
      this.onsetPeakRms = 0;
      this.lastOnsetRejectedReason = "below_snr";
      return;
    }
    if (this.onsetAboveSinceMs == null) this.onsetAboveSinceMs = nowMs;
    const held = nowMs - this.onsetAboveSinceMs;
    if (held < ONSET_HOLD_MS) {
      this.lastOnsetRejectedReason = "hold_incomplete";
      return;
    }
    if (!this.sawOnsetBurst && variance < ONSET_MIN_VARIANCE) {
      this.lastOnsetRejectedReason = "steady_noise";
      voiceClientLog("onset_rejected_reason", {
        turn_id: this.turnId,
        reason: "steady_noise",
        vad_noise_floor: Number(this.ambientBaseline.toFixed(4)),
        onset_snr: this.lastOnsetSnr,
        variance: Number(variance.toFixed(8)),
      });
      return;
    }
    // Far talk: energy crossed a soft bar but never reached close-talk peak.
    if (this.onsetPeakRms < CLOSE_TALK_ABSOLUTE) {
      this.lastOnsetRejectedReason = "far_talk";
      voiceClientLog("onset_rejected_reason", {
        turn_id: this.turnId,
        reason: "far_talk",
        vad_noise_floor: Number(this.ambientBaseline.toFixed(4)),
        onset_snr: this.lastOnsetSnr,
        onset_peak: Number(this.onsetPeakRms.toFixed(4)),
      });
      return;
    }

    this.lastOnsetRejectedReason = null;
    voiceClientLog("vad_noise_floor", {
      turn_id: this.turnId,
      vad_noise_floor: Number(this.ambientBaseline.toFixed(4)),
      onset_snr: this.lastOnsetSnr,
      onset_floor: Number(floor.toFixed(4)),
      close_talk: true,
    });
    this.noteSpeechConfirmed(nowMs);
  }

  private logNoiseFloor(nowMs: number, reason: string): void {
    if (nowMs - this.lastNoiseFloorLogAt < 1000 && reason !== "confirmed") return;
    this.lastNoiseFloorLogAt = nowMs;
    voiceClientLog("vad_noise_floor", {
      turn_id: this.turnId,
      vad_noise_floor: Number(this.ambientBaseline.toFixed(4)),
      onset_snr: this.lastOnsetSnr,
      speech_peak: Number(this.speechPeakRms.toFixed(4)),
      reason,
    });
  }

  handleAudioFrame(turnId: number, rms: number, nowMs: number): void {
    if (turnId !== this.turnId || !this.isCurrent() || this.finished) return;

    if (this.firstFrameAtMs == null) this.firstFrameAtMs = nowMs;
    const dtMs = this.lastFrameAtMs == null ? 0 : Math.min(50, Math.max(0, nowMs - this.lastFrameAtMs));
    this.lastFrameAtMs = nowMs;
    if (!this.smoothingInitialized) {
      this.smoothingInitialized = true;
      this.smoothedRms = rms;
    } else {
      const alpha = 1 - Math.exp(-dtMs / SMOOTH_WINDOW_MS);
      this.smoothedRms += alpha * (rms - this.smoothedRms);
    }

    this.pushRecentRms(rms, nowMs);

    if (!this.confirmedSpeech) {
      this.updateNoiseFloor(rms, nowMs);
      if (nowMs - (this.firstFrameAtMs ?? nowMs) >= Math.min(120, NOISE_FLOOR_WINDOW_MS * 0.5)) {
        this.tryConfirmSpeech(rms, nowMs);
      }
      if (!this.confirmedSpeech) {
        this.logNoiseFloor(nowMs, "calibrating");
        return;
      }
    }

    this.speechPeakRms = Math.max(this.speechPeakRms, rms, this.smoothedRms);

    if (this.smoothedRms > this.meaningfulFloor) {
      this.lastMeaningfulSpeechAtMs = nowMs;
    }
    if (this.smoothedRms < this.quietCeiling) {
      if (this.quietSinceMs == null) this.quietSinceMs = nowMs;
    } else {
      this.quietSinceMs = null;
    }

    if (nowMs - this.confirmedAtMs < MIN_AFTER_CONFIRM_MS) return;

    if (this.quietSinceMs != null && nowMs - this.quietSinceMs >= QUIET_AFTER_SPEECH_MS) {
      this.finishTurnOnce(turnId, "post_speech_quiet", nowMs);
      return;
    }
    if (nowMs - this.lastMeaningfulSpeechAtMs >= LAST_SPEECH_GAP_MS) {
      this.finishTurnOnce(turnId, "last_speech_gap", nowMs);
    }
  }

  finishTurnOnce(turnId: number, reason: EndpointReason, nowMs?: number): boolean {
    if (this.finished) {
      console.info(`[audio] finish_turn_ignored turn_id=${turnId} reason=${reason} cause=already_finished`);
      voiceClientLog("finish_turn_ignored", { turn_id: turnId, reason, cause: "already_finished" });
      return false;
    }
    if (turnId !== this.turnId || !this.isCurrent()) {
      console.info(`[audio] finish_turn_ignored turn_id=${turnId} reason=${reason} cause=stale_turn`);
      voiceClientLog("finish_turn_ignored", { turn_id: turnId, reason, cause: "stale_turn" });
      return false;
    }
    this.finished = true;
    const now = nowMs ?? this.lastFrameAtMs ?? 0;
    const ageMs = Math.round(now - this.startedAtMs);
    console.info(
      `[audio] endpoint_decision turn_id=${turnId} reason=${reason} ambient_rms=${this.ambientBaseline.toFixed(4)} smoothed_rms=${this.smoothedRms.toFixed(4)} quiet_ceiling=${this.quietCeiling.toFixed(4)} speech_peak=${this.speechPeakRms.toFixed(4)} recording_age_ms=${ageMs}`,
    );
    voiceClientLog("endpoint_decision", {
      turn_id: turnId,
      reason,
      ambient_rms: Number(this.ambientBaseline.toFixed(4)),
      vad_noise_floor: Number(this.ambientBaseline.toFixed(4)),
      smoothed_rms: Number(this.smoothedRms.toFixed(4)),
      quiet_ceiling: this.quietCeiling,
      speech_peak: Number(this.speechPeakRms.toFixed(4)),
      onset_snr: this.lastOnsetSnr,
      recording_age_ms: ageMs,
    });
    this.onFinish(reason);
    return true;
  }
}
