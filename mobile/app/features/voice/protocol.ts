export type VoiceState =
  | "IDLE"
  | "CONNECTING"
  | "READY"
  | "LISTENING"
  | "USER_SPEAKING"
  | "ENDPOINTING"
  | "THINKING"
  | "SPEAKING"
  | "INTERRUPTED"
  | "RECONNECTING"
  | "ERROR";

type EventBase = {
  protocol: "voice.v1";
  sessionId: string;
  turnId: string;
};

export type VoiceEvent =
  | (EventBase & { type: "session.ready" })
  | (EventBase & { type: "transcript.partial"; text: string })
  | (EventBase & { type: "transcript.final"; text: string })
  | (EventBase & { type: "assistant.text.delta"; text: string })
  | (EventBase & { type: "assistant.audio.started" })
  | (EventBase & {
      type: "assistant.audio.chunk";
      sequence: number;
      heardUntilMs?: number;
    })
  | (EventBase & { type: "assistant.audio.finished" })
  | (EventBase & { type: "barge_in"; reason: string })
  | (EventBase & { type: "turn.cancelled"; reason: string })
  | (EventBase & { type: "error"; code: string; message: string });

export type VoiceCommand =
  | { type: "session.connect" }
  | { type: "session.reconnected" }
  | { type: "session.error"; code: string; message: string }
  | { type: "turn.begin"; turnId: string }
  | { type: "turn.endpoint" }
  | { type: "barge_in"; reason?: string }
  | { type: "reconnect" }
  | { type: "reset" };

export type VoiceSnapshot = {
  state: VoiceState;
  sessionId: string | null;
  activeTurnId: string | null;
  transcript: string;
  assistantText: string;
  heardAudioMs: number;
  lastError: { code: string; message: string } | null;
};
