/**
 * Authoritative per-turn endpoint owner.
 *
 * ONE instance per turn. The recorder's worklet RMS callback feeds
 * handleAudioFrame(turnId, rms, nowMs); speech onset + silence/gap detection
 * finish ONLY through finishTurnOnce(turnId, reason).
 *
 * Adaptive noise-floor endpoint (tracks the USER'S voice, not absolute loudness):
 *   noiseFloor — rolling mean from the first ~400ms and continuously during
 *                non-speech (a fan raises the floor; steady noise alone never
 *                confirms speech).
 *   onset      — smoothedRms > max(ABSOLUTE_FLOOR, noiseFloor × ONSET_SNR)
 *                sustained for ≥ ONSET_HOLD_MS, AND RMS variance over the
 *                window is above ONSET_MIN_VARIANCE (rejects steady machine noise).
 *   quietCeiling = max(QUIET_ABSOLUTE_FLOOR, noiseFloor × QUIET_NOISE_MULT)
 *   post_speech_quiet — smoothedRms < quietCeiling continuously for 900ms
 *   last_speech_gap   — 2500ms since lastMeaningfulSpeechAt
 *   Never endpoint before 1200ms after confirmed speech begins.
 *   max_recording (15s) stays emergency-only.
 *
 * All events go to BOTH console.info and voiceClientLog (the on-device ring
 * the phone exports) — console-only logs are invisible in production captures.
 */

import { voiceClientLog } from "@/lib/debug";

export const QUIET_AFTER_SPEECH_MS = 900;
export const LAST_SPEECH_GAP_MS = 2500;
export const MIN_AFTER_CONFIRM_MS = 1200;
/** Calibrate noise floor from the first ~400ms of each recording. */
export const NOISE_FLOOR_WINDOW_MS = 400;
export const SMOOTH_WINDOW_MS = 100;
/** End turn when RMS falls back near noise_floor × 1.5. */
export const QUIET_NOISE_MULT = 1.5;
/** Tiny absolute quiet floor for numerical stability only (not a speech gate). */
export const QUIET_ABSOLUTE_FLOOR = 0.008;
/** Speech onset: RMS > max(absolute_floor, noise_floor × SNR). */
export const ONSET_SNR = 3;
export const ONSET_ABSOLUTE_FLOOR = 0.02;
/** Sustain above onset threshold before confirming speech. */
export const ONSET_HOLD_MS = 250;
/** Rolling window for onset variance / burstiness check. */
export const ONSET_VARIANCE_WINDOW_MS = 250;
/**
 * Minimum RMS variance in the onset window. Steady fan/broadband noise is
 * nearly flat; speech is bursty. Tuned for worklet RMS in 0..1.
 */
export const ONSET_MIN_VARIANCE = 0.000008;
/** Meaningful speech after confirm — relative to noise floor. */
export const MEANINGFUL_NOISE_MULT = 2.2;
export const MEANINGFUL_ABSOLUTE_FLOOR = 0.03;

/** @deprecated Use NOISE_FLOOR_WINDOW_MS */
export const AMBIENT_WINDOW_MS = NOISE_FLOOR_WINDOW_MS;
/** @deprecated Use QUIET_NOISE_MULT */
export const QUIET_AMBIENT_MULT = QUIET_NOISE_MULT;
/** @deprecated Fixed quiet floor removed — relative only. */
export const QUIET_RMS_FLOOR = QUIET_ABSOLUTE_FLOOR;
/** @deprecated Use MEANINGFUL_NOISE_MULT */
export const MEANINGFUL_AMBIENT_MULT = MEANINGFUL_NOISE_MULT;
/** @deprecated Use MEANINGFUL_ABSOLUTE_FLOOR */
export const MEANINGFUL_RMS_FLOOR = MEANINGFUL_ABSOLUTE_FLOOR;

export type EndpointReason = "post_speech_quiet" | "last_speech_gap" | "max_recording";
export type OnsetRejectedReason = "below_snr" | "steady_noise" | "hold_incomplete";

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
  /** Rolling noise-floor estimate (ambient). */
  ambientBaseline = 0;
  smoothedRms = 0;
  confirmedSpeech = false;
  finished = false;
  lastOnsetRejectedReason: OnsetRejectedReason | null = null;
  lastOnsetSnr = 0;

  private ambientSum = 0;
  private ambientCount = 0;
  private firstFrameAtMs: number | null = null;
  private lastFrameAtMs: number | null = null;
  private smoothingInitialized = false;
  private confirmedAtMs = 0;
  private quietSinceMs: number | null = null;
  private lastMeaningfulSpeechAtMs = 0;

  private onsetAboveSinceMs: number | null = null;
  private recentRms: Array<{ t: number; rms: number }> = [];
  private lastNoiseFloorLogAt = 0;
  /** Latched when the onset window shows bursty energy (speech rise). */
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

  /** Called on recorder detach — frames/completions after this are stale. */
  invalidate(): void {
    if (this.isCurrent()) activeTurn = null;
  }

  get noiseFloor(): number {
    return this.ambientBaseline;
  }

  get quietCeiling(): number {
    return Math.max(this.ambientBaseline * QUIET_NOISE_MULT, QUIET_ABSOLUTE_FLOOR);
  }

  private get onsetFloor(): number {
    return Math.max(ONSET_ABSOLUTE_FLOOR, this.ambientBaseline * ONSET_SNR);
  }

  private get meaningfulFloor(): number {
    return Math.max(this.ambientBaseline * MEANINGFUL_NOISE_MULT, MEANINGFUL_ABSOLUTE_FLOOR);
  }

  quietMs(nowMs: number): number {
    return this.quietSinceMs == null ? 0 : Math.max(0, nowMs - this.quietSinceMs);
  }

  sinceLastMeaningfulSpeechMs(nowMs: number): number {
    if (!this.confirmedSpeech) return 0;
    return Math.max(0, nowMs - this.lastMeaningfulSpeechAtMs);
  }

  /** 0..1 quiet progress toward post_speech_quiet (UI auto-stop ring). */
  quietProgress(nowMs: number): number {
    return Math.min(1, this.quietMs(nowMs) / QUIET_AFTER_SPEECH_MS);
  }

  /**
   * External confirm (legacy recorder path). Prefer internal adaptive onset.
   */
  noteSpeechConfirmed(nowMs: number): void {
    if (this.confirmedSpeech) return;
    this.confirmedSpeech = true;
    this.confirmedAtMs = nowMs;
    this.lastMeaningfulSpeechAtMs = nowMs;
    this.quietSinceMs = null;
    this.onsetAboveSinceMs = null;
    if (this.ambientCount > 0) this.ambientBaseline = this.ambientSum / this.ambientCount;
    this.logNoiseFloor(nowMs, "confirmed");
  }

  private updateNoiseFloor(rms: number, nowMs: number): void {
    if (this.firstFrameAtMs == null) return;
    const inCalibration = nowMs - this.firstFrameAtMs <= NOISE_FLOOR_WINDOW_MS;
    // Reject speech-like spikes so they never inflate the floor.
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
    // Continuous non-speech tracking: only adapt when energy is near the
    // current floor (fan/ambient). Rising speech edges must not chase the floor up.
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
    const varSum = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
    return varSum;
  }

  private tryConfirmSpeech(rms: number, nowMs: number): void {
    const floor = this.onsetFloor;
    const snr = this.ambientBaseline > 1e-9 ? this.smoothedRms / this.ambientBaseline : 0;
    this.lastOnsetSnr = Number(snr.toFixed(3));
    const above = this.smoothedRms > floor;
    const variance = this.rmsVariance();
    if (variance >= ONSET_MIN_VARIANCE) this.sawOnsetBurst = true;

    if (!above) {
      this.onsetAboveSinceMs = null;
      this.lastOnsetRejectedReason = "below_snr";
      return;
    }
    if (this.onsetAboveSinceMs == null) this.onsetAboveSinceMs = nowMs;
    const held = nowMs - this.onsetAboveSinceMs;
    if (held < ONSET_HOLD_MS) {
      this.lastOnsetRejectedReason = "hold_incomplete";
      return;
    }
    // Steady machine noise: elevated RMS with no burst/onset dynamics.
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
    this.lastOnsetRejectedReason = null;
    voiceClientLog("vad_noise_floor", {
      turn_id: this.turnId,
      vad_noise_floor: Number(this.ambientBaseline.toFixed(4)),
      onset_snr: this.lastOnsetSnr,
      onset_floor: Number(floor.toFixed(4)),
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
      reason,
    });
  }

  /**
   * ONE authoritative frame handler, fed by the recorder's worklet callback.
   * Stale frames (old turn / invalidated generation / finished) are rejected.
   */
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
      // Wait for initial calibration before onset decisions.
      if (nowMs - (this.firstFrameAtMs ?? nowMs) >= Math.min(120, NOISE_FLOOR_WINDOW_MS * 0.5)) {
        this.tryConfirmSpeech(rms, nowMs);
      }
      if (!this.confirmedSpeech) {
        this.logNoiseFloor(nowMs, "calibrating");
        return;
      }
    }

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

  /**
   * THE only way a turn ends. Idempotent; stale/duplicate attempts are
   * blocked and logged as finish_turn_ignored.
   */
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
      `[audio] endpoint_decision turn_id=${turnId} reason=${reason} ambient_rms=${this.ambientBaseline.toFixed(4)} smoothed_rms=${this.smoothedRms.toFixed(4)} quiet_ceiling=${this.quietCeiling.toFixed(4)} recording_age_ms=${ageMs}`,
    );
    voiceClientLog("endpoint_decision", {
      turn_id: turnId,
      reason,
      ambient_rms: Number(this.ambientBaseline.toFixed(4)),
      vad_noise_floor: Number(this.ambientBaseline.toFixed(4)),
      smoothed_rms: Number(this.smoothedRms.toFixed(4)),
      quiet_ceiling: this.quietCeiling,
      onset_snr: this.lastOnsetSnr,
      recording_age_ms: ageMs,
    });
    this.onFinish(reason);
    return true;
  }
}
