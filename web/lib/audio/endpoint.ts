/**
 * Authoritative per-turn endpoint owner.
 *
 * ONE instance per turn. The recorder's worklet RMS callback feeds
 * handleAudioFrame(turnId, rms, nowMs); the max-recording timer and all
 * silence/gap detection finish ONLY through finishTurnOnce(turnId, reason).
 *
 * Endpoint rule (after the existing 24-frame speech-start confirmation):
 *   ambientBaseline — mean RMS of the first 500ms before confirmed speech, then FROZEN.
 *   quietCeiling    = max(ambientBaseline * 1.6, 0.045)
 *   meaningful      = smoothedRms > max(ambientBaseline * 2.2, 0.07)
 *                     (stricter than quietCeiling so steady noise above the
 *                      quiet ceiling cannot masquerade as speech forever —
 *                      that is what last_speech_gap rescues)
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
export const AMBIENT_WINDOW_MS = 500;
export const SMOOTH_WINDOW_MS = 100;
export const QUIET_AMBIENT_MULT = 1.6;
export const QUIET_RMS_FLOOR = 0.045;
export const MEANINGFUL_AMBIENT_MULT = 2.2;
export const MEANINGFUL_RMS_FLOOR = 0.07;

export type EndpointReason = "post_speech_quiet" | "last_speech_gap" | "max_recording";

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

  private ambientSum = 0;
  private ambientCount = 0;
  private ambientFrozen = false;
  private firstFrameAtMs: number | null = null;
  private lastFrameAtMs: number | null = null;
  private smoothingInitialized = false;
  private confirmedAtMs = 0;
  private quietSinceMs: number | null = null;
  private lastMeaningfulSpeechAtMs = 0;

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

  get quietCeiling(): number {
    return Math.max(this.ambientBaseline * QUIET_AMBIENT_MULT, QUIET_RMS_FLOOR);
  }

  private get meaningfulFloor(): number {
    return Math.max(this.ambientBaseline * MEANINGFUL_AMBIENT_MULT, MEANINGFUL_RMS_FLOOR);
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

  /** Recorder calls this when the existing 24-frame start confirmation succeeds. */
  noteSpeechConfirmed(nowMs: number): void {
    if (this.confirmedSpeech) return;
    this.confirmedSpeech = true;
    this.confirmedAtMs = nowMs;
    this.lastMeaningfulSpeechAtMs = nowMs;
    this.quietSinceMs = null;
    this.ambientFrozen = true;
    if (this.ambientCount > 0) this.ambientBaseline = this.ambientSum / this.ambientCount;
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

    if (!this.confirmedSpeech) {
      // Ambient baseline: first 500ms before confirmed speech, then frozen.
      // Outlier rejection keeps the ~64ms speech run-up (and bumps) out of the mean.
      if (!this.ambientFrozen && nowMs - this.firstFrameAtMs <= AMBIENT_WINDOW_MS) {
        const cap = this.ambientCount === 0 ? Infinity : Math.max(this.ambientBaseline * 2, 0.02);
        if (rms <= cap) {
          this.ambientSum += rms;
          this.ambientCount += 1;
          this.ambientBaseline = this.ambientSum / this.ambientCount;
        }
      } else {
        this.ambientFrozen = true;
      }
      return;
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
      smoothed_rms: Number(this.smoothedRms.toFixed(4)),
      quiet_ceiling: this.quietCeiling,
      recording_age_ms: ageMs,
    });
    this.onFinish(reason);
    return true;
  }
}
