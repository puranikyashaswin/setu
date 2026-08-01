/**
 * Fresh-load greeting + voice-session bootstrap (testable without React).
 *
 * History may be restored into the UI, but voice always starts as a NEW
 * session: greeting plays at most once per page load, and subsequent orb/mic
 * taps only start listening.
 */

export type GreetingGate = {
  /** Set true after the first greeting of this page load. */
  greetingPlayedThisLoad: boolean;
  onboarded: boolean;
  turnCount: number;
};

export type PageLoadVoiceState = {
  /** Keep chat history; reset ephemeral voice flags. */
  keepHistory: boolean;
  greetingPlayedThisLoad: boolean;
  /** True when the restored chat already has turns / was onboarded. */
  hasStarted: boolean;
  /** Fresh id for this browser voice session (not the chat session id). */
  voiceSessionId: string;
  staleSessionCleared: boolean;
};

export function shouldPlayGreeting(gate: GreetingGate): boolean {
  if (gate.greetingPlayedThisLoad) return false;
  return !gate.onboarded && gate.turnCount === 0;
}

/** After greeting has played once this load, taps only start listening. */
export function shouldStartListeningOnTap(gate: GreetingGate): boolean {
  return !shouldPlayGreeting(gate);
}

export function resolvePageLoadVoiceState(options: {
  historyTurnCount: number;
  onboarded: boolean;
  newId?: () => string;
}): PageLoadVoiceState {
  const newId = options.newId ?? (() => crypto.randomUUID());
  return {
    keepHistory: true,
    greetingPlayedThisLoad: false,
    hasStarted: options.historyTurnCount > 0 || options.onboarded,
    voiceSessionId: newId(),
    staleSessionCleared: true,
  };
}

/** Pure sequencing helper for the first-tap arm → greet → auto-listen path. */
export type FirstTapPlan =
  | { action: "play_greeting"; autoListenAfter: true }
  | { action: "start_listening" };

export function planFirstOrbTap(gate: GreetingGate): FirstTapPlan {
  if (shouldPlayGreeting(gate)) {
    return { action: "play_greeting", autoListenAfter: true };
  }
  return { action: "start_listening" };
}
