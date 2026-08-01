/**
 * Voice v2 (server_vad_v1) client-side session manager + per-turn controller.
 *
 * Fallback contract (locked per voice session):
 *  - Wait for voice_v2_ready ONCE at session startup (1s).
 *  - Once ready → locked into server_vad_v1 for the session lifetime.
 *  - Never fall back because an individual VAD event is merely late.
 *  - Fall back only on: startup_timeout | ws_error | mode_mismatch | finalize_deadline.
 * live_v2 is a recognized-but-unimplemented server mode; mode_not_implemented
 * from the server is treated as mode_mismatch → deterministic legacy behavior.
 */

import { voiceClientLog } from "@/lib/debug";

export const VOICE_TURN_MODE: "legacy_client" | "server_vad_v1" =
  process.env.NEXT_PUBLIC_VOICE_TURN_MODE === "server_vad_v1" ? "server_vad_v1" : "legacy_client";
export const BARGE_IN_ENABLED = process.env.NEXT_PUBLIC_VOICE_BARGE_IN_ENABLED === "true";

export const VAD_READY_TIMEOUT_MS = 1000;
/** After confirmed local speech with no server turn_finalized — legacy submit. */
export const FINALIZE_DEADLINE_MS = 8000;

export type VadFallbackReason = "startup_timeout" | "ws_error" | "mode_mismatch" | "finalize_deadline";

type SessionMode = "startup_pending" | "server_locked" | "legacy";

export class VoiceV2SessionManager {
  private mode: SessionMode;

  constructor(private readonly requestedMode: string = VOICE_TURN_MODE) {
    this.mode = requestedMode === "server_vad_v1" ? "startup_pending" : "legacy";
  }

  /** True only when this turn should stream PCM and wait for server finalization. */
  get serverVadActive(): boolean {
    return this.mode === "server_locked";
  }

  /** Called when voice_v2_ready arrives. Locks the session into server_vad_v1.
   *  Only honored during startup_pending — after a legacy lock-in (timeout,
   *  mismatch, ws_error) a late ready must NOT flip the session back. */
  noteReady(engine: string): void {
    if (this.requestedMode !== "server_vad_v1" || this.mode !== "startup_pending") return;
    this.mode = "server_locked";
    voiceClientLog("voice_v2_ready", { engine });
  }

  noteStartupTimeout(): void {
    if (this.mode !== "startup_pending") return;
    this.mode = "legacy";
    this.fallback("startup_timeout");
  }

  noteWsError(): void {
    if (this.mode === "legacy") return;
    this.mode = "legacy";
    this.fallback("ws_error");
  }

  /** Server ready/mode_not_implemented disagrees with the requested mode. */
  noteModeMismatch(serverMode: string): void {
    if (this.mode === "legacy") return;
    this.mode = "legacy";
    voiceClientLog("mode_mismatch", { server_mode: serverMode });
    this.fallback("mode_mismatch");
  }

  noteFinalizeDeadline(turnId: number): void {
    voiceClientLog("fallback_to_legacy", { reason: "finalize_deadline", turn_id: turnId });
    console.info(`[audio] fallback_to_legacy reason=finalize_deadline turn_id=${turnId}`);
  }

  /** New socket connected: re-arm readiness; a fresh voice_v2_ready re-locks. */
  noteReconnect(): void {
    if (this.requestedMode !== "server_vad_v1") return;
    this.mode = "startup_pending";
  }

  private fallback(reason: VadFallbackReason): void {
    console.info(`[audio] fallback_to_legacy reason=${reason}`);
    voiceClientLog("fallback_to_legacy", { reason });
  }
}

export type VadServerEvent = {
  type?: string;
  voice_session_id?: string;
  turn_id?: number;
  sequence?: number;
  turn_finalize_reason?: string;
};

/**
 * Per-turn server-VAD event gate: rejects stale turns and duplicate/old
 * sequences, fires onFinalized exactly once, and never flips UI state on
 * anything except turn_finalized.
 */
export class ServerVadTurnController {
  private lastSequence = 0;
  private finalized = false;

  constructor(
    readonly turnId: number,
    private readonly callbacks: {
      onFinalized: (turnId: number, reason: string) => void;
      onSpeechStart?: (turnId: number) => void;
      onEndCandidate?: (turnId: number) => void;
    },
  ) {}

  get isFinalized(): boolean {
    return this.finalized;
  }

  /** Returns true when the event was accepted (current turn, fresh sequence). */
  handleEvent(msg: VadServerEvent): boolean {
    const turnId = Number(msg.turn_id ?? -1);
    const sequence = Number(msg.sequence ?? 0);
    if (turnId !== this.turnId || this.finalized) return false;
    if (sequence <= this.lastSequence) return false;
    this.lastSequence = sequence;

    if (msg.type === "vad_speech_start") {
      this.callbacks.onSpeechStart?.(this.turnId);
      return true;
    }
    if (msg.type === "vad_speech_end_candidate") {
      this.callbacks.onEndCandidate?.(this.turnId);
      return true;
    }
    if (msg.type === "turn_finalized") {
      this.finalized = true;
      this.callbacks.onFinalized(this.turnId, String(msg.turn_finalize_reason || "vad_silence"));
      return true;
    }
    return false;
  }
}
