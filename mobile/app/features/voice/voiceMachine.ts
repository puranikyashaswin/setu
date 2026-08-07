import type { VoiceCommand, VoiceEvent, VoiceSnapshot, VoiceState } from "./protocol";

const allowed: Record<VoiceState, readonly VoiceState[]> = {
  IDLE: ["CONNECTING"],
  CONNECTING: ["READY", "ERROR", "RECONNECTING"],
  READY: ["LISTENING", "RECONNECTING", "ERROR"],
  LISTENING: ["USER_SPEAKING", "READY", "RECONNECTING", "ERROR"],
  USER_SPEAKING: ["ENDPOINTING", "INTERRUPTED", "ERROR", "RECONNECTING"],
  ENDPOINTING: ["THINKING", "LISTENING", "INTERRUPTED", "ERROR"],
  THINKING: ["SPEAKING", "INTERRUPTED", "ERROR", "RECONNECTING"],
  SPEAKING: ["LISTENING", "INTERRUPTED", "RECONNECTING", "ERROR"],
  INTERRUPTED: ["LISTENING", "THINKING", "READY", "ERROR"],
  RECONNECTING: ["READY", "ERROR", "CONNECTING"],
  ERROR: ["RECONNECTING", "CONNECTING", "IDLE"],
};

export const initialVoiceSnapshot: VoiceSnapshot = {
  state: "IDLE",
  sessionId: null,
  activeTurnId: null,
  transcript: "",
  assistantText: "",
  heardAudioMs: 0,
  lastError: null,
};

function move(snapshot: VoiceSnapshot, next: VoiceState): VoiceSnapshot {
  if (snapshot.state === next) return snapshot;
  if (!allowed[snapshot.state].includes(next)) {
    throw new Error(`Invalid voice transition: ${snapshot.state} -> ${next}`);
  }
  return { ...snapshot, state: next };
}

function isCurrentTurn(snapshot: VoiceSnapshot, event: VoiceEvent): boolean {
  return Boolean(snapshot.sessionId === event.sessionId && snapshot.activeTurnId === event.turnId);
}

export function reduceVoiceEvent(snapshot: VoiceSnapshot, event: VoiceEvent): VoiceSnapshot {
  if (event.type === "session.ready") {
    return move({ ...snapshot, sessionId: event.sessionId, lastError: null }, "READY");
  }
  if (!isCurrentTurn(snapshot, event)) return snapshot;

  switch (event.type) {
    case "transcript.partial":
      return { ...move(snapshot, "USER_SPEAKING"), transcript: event.text };
    case "transcript.final": {
      const endpointing = snapshot.state === "USER_SPEAKING" ? move(snapshot, "ENDPOINTING") : snapshot;
      return { ...move(endpointing, "THINKING"), transcript: event.text };
    }
    case "assistant.text.delta":
      return { ...move(snapshot, "THINKING"), assistantText: snapshot.assistantText + event.text };
    case "assistant.audio.started":
      return move(snapshot, "SPEAKING");
    case "assistant.audio.chunk":
      return {
        ...move(snapshot, "SPEAKING"),
        heardAudioMs: event.heardUntilMs ?? snapshot.heardAudioMs,
      };
    case "assistant.audio.finished":
      return move(snapshot, "LISTENING");
    case "barge_in":
      return { ...move(snapshot, "INTERRUPTED"), activeTurnId: null };
    case "turn.cancelled":
      return { ...move(snapshot, "INTERRUPTED"), activeTurnId: null };
    case "error":
      return { ...move(snapshot, "ERROR"), lastError: { code: event.code, message: event.message } };
    default:
      return snapshot;
  }
}

export function reduceVoiceCommand(snapshot: VoiceSnapshot, command: VoiceCommand): VoiceSnapshot {
  switch (command.type) {
    case "session.connect":
      return move(snapshot, "CONNECTING");
    case "session.reconnected":
      return move(snapshot, "READY");
    case "session.error":
      return { ...move(snapshot, "ERROR"), lastError: { code: command.code, message: command.message } };
    case "turn.begin": {
      const base = snapshot.state === "READY" || snapshot.state === "INTERRUPTED" ? move(snapshot, "LISTENING") : snapshot;
      return { ...move(base, "USER_SPEAKING"), activeTurnId: command.turnId, transcript: "", assistantText: "", heardAudioMs: 0, lastError: null };
    }
    case "turn.endpoint":
      return move(snapshot, "ENDPOINTING");
    case "barge_in":
      return { ...move(snapshot, "INTERRUPTED"), activeTurnId: null };
    case "reconnect":
      return { ...move(snapshot, "RECONNECTING"), activeTurnId: null };
    case "reset":
      return initialVoiceSnapshot;
  }
}

export function isStaleEvent(snapshot: VoiceSnapshot, event: VoiceEvent): boolean {
  return event.type !== "session.ready" && !isCurrentTurn(snapshot, event);
}
