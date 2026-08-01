/** Single-flight voice loop state — testable without React. */

export type VoiceLoopState =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "scanning"
  | "stopped";

export type MicOpenSkipReason = "already_listening" | "stale_turn" | "not_active";

export type VoiceLoop = {
  state: VoiceLoopState;
  turnId: number;
  listenGeneration: number;
  browserSttDisabled: boolean;
  transition: (to: VoiceLoopState, reason: string) => void;
  /** Bump turn id when a new speak/listen cycle starts. */
  beginTurn: () => number;
  /**
   * Gate auto-relisten. Returns {ok:true} only when idle and turn matches.
   * Claims listening immediately so rapid duplicate calls skip.
   */
  tryResumeListening: (fromTurnId: number) =>
    | { ok: true; turnId: number }
    | { ok: false; reason: MicOpenSkipReason };
  /** Call when mic actually opens. */
  noteMicOpen: (turnId: number) => { ok: true } | { ok: false; reason: MicOpenSkipReason };
  noteBrowserSttUnavailable: () => void;
  reset: () => void;
};

export function createVoiceLoop(
  onLog?: (event: string, data: Record<string, unknown>) => void,
): VoiceLoop {
  let state: VoiceLoopState = "idle";
  let turnId = 0;
  let listenGeneration = 0;
  let browserSttDisabled = false;
  let resumeClaimed = false;

  const log = (event: string, data: Record<string, unknown>) => {
    onLog?.(event, data);
  };

  const loop: VoiceLoop = {
    get state() {
      return state;
    },
    get turnId() {
      return turnId;
    },
    get listenGeneration() {
      return listenGeneration;
    },
    get browserSttDisabled() {
      return browserSttDisabled;
    },
    transition(to, reason) {
      const from = state;
      if (from === to) return;
      state = to;
      if (to !== "listening") resumeClaimed = false;
      log("voice_state", { from, to, reason });
    },
    beginTurn() {
      turnId += 1;
      resumeClaimed = false;
      return turnId;
    },
    tryResumeListening(fromTurnId) {
      if (fromTurnId !== turnId) {
        log("mic_open_skipped", { reason: "stale_turn", turn_id: fromTurnId, current: turnId });
        return { ok: false, reason: "stale_turn" };
      }
      if (resumeClaimed || state === "listening") {
        log("mic_open_skipped", { reason: "already_listening", turn_id: turnId });
        return { ok: false, reason: "already_listening" };
      }
      if (state === "thinking" || state === "speaking" || state === "scanning" || state === "stopped") {
        log("mic_open_skipped", { reason: "not_active", state, turn_id: turnId });
        return { ok: false, reason: "not_active" };
      }
      // Claim listening slot immediately (before mic opens) to collapse bursts.
      resumeClaimed = true;
      listenGeneration += 1;
      const from = state;
      state = "listening";
      log("voice_state", { from, to: "listening", reason: "auto_relisten" });
      return { ok: true, turnId };
    },
    noteMicOpen(openTurnId) {
      if (openTurnId !== turnId) {
        log("mic_open_skipped", { reason: "stale_turn", turn_id: openTurnId });
        return { ok: false, reason: "stale_turn" };
      }
      if (state !== "listening" && state !== "idle") {
        // Allow idle→listening if tryResume wasn't used (manual tap).
        if (state === "thinking" || state === "speaking" || state === "scanning" || state === "stopped") {
          log("mic_open_skipped", { reason: "not_active", state });
          return { ok: false, reason: "not_active" };
        }
      }
      if (state !== "listening") {
        const from = state;
        state = "listening";
        log("voice_state", { from, to: "listening", reason: "mic_open" });
      }
      log("mic_open", { turn_id: openTurnId });
      return { ok: true };
    },
    noteBrowserSttUnavailable() {
      browserSttDisabled = true;
    },
    reset() {
      state = "idle";
      turnId = 0;
      listenGeneration = 0;
      browserSttDisabled = false;
      resumeClaimed = false;
    },
  };

  return loop;
}
