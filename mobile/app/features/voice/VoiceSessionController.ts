import { createRealtimeSession, type RealtimeSession } from "../../services/api";
import { nativeAudio } from "../../services/nativeAudio";
import { LiveKitRealtimeTransport } from "../../services/realtime";
import { initialVoiceSnapshot, reduceVoiceCommand, reduceVoiceEvent } from "./voiceMachine";
import type { VoiceEvent, VoiceSnapshot } from "./protocol";

type Listener = (snapshot: VoiceSnapshot) => void;

/** Coordinates the LiveKit room and the one voice FSM for push-to-talk. */
export class VoiceSessionController {
  private snapshot = initialVoiceSnapshot;
  private readonly listeners = new Set<Listener>();
  private readonly transport = new LiveKitRealtimeTransport();
  private realtime: RealtimeSession | null = null;

  constructor(private readonly userId: string, private readonly language: string) {}

  get state(): VoiceSnapshot {
    return this.snapshot;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  async connect(): Promise<void> {
    this.dispatchCommand({ type: "session.connect" });
    try {
      this.realtime = await createRealtimeSession({ userId: this.userId, language: this.language });
      if (this.realtime.transport !== "livekit" || !this.realtime.serverUrl) {
        throw new Error("LiveKit media service is not configured");
      }
      let resolveReady: (() => void) | undefined;
      let rejectReady: ((error: Error) => void) | undefined;
      const workerReady = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      await this.transport.connect({
        sessionId: this.realtime.sessionId,
        serverUrl: this.realtime.serverUrl,
        token: this.realtime.token,
        onControlEvent: (event) => {
          this.receive(event);
          if (isSessionReady(event, this.realtime?.sessionId)) resolveReady?.();
        },
        onReconnecting: () => this.dispatchCommand({ type: "reconnect" }),
        onReconnected: () => this.dispatchCommand({ type: "session.reconnected" }),
        onDisconnected: (reason) => this.dispatchCommand({ type: "session.error", code: "disconnected", message: reason ?? "Voice connection ended" }),
        onTelemetry: (name) => this.logTelemetry(name),
      });
      const timeout = setTimeout(() => rejectReady?.(new Error("Voice worker did not become ready")), 8_000);
      try {
        await workerReady;
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      this.dispatchCommand({ type: "session.error", code: "connect_failed", message: error instanceof Error ? error.message : "Could not start voice" });
      throw error;
    }
  }

  async beginTurn(turnId: string): Promise<void> {
    if (!this.realtime) throw new Error("Voice session is not connected");
    this.dispatchCommand({ type: "turn.begin", turnId });
    await this.transport.startPushToTalk();
    this.logTelemetry("mic_ready", turnId);
    this.transport.sendControl({ type: "turn.start", sessionId: this.realtime.sessionId, turnId });
  }

  async endTurn(): Promise<void> {
    const turnId = this.snapshot.activeTurnId;
    if (!turnId || !this.realtime) return;
    await this.transport.endPushToTalk();
    this.logTelemetry("mic_stopped", turnId);
    this.dispatchCommand({ type: "turn.endpoint" });
    this.transport.sendControl({ type: "turn.stop", sessionId: this.realtime.sessionId, turnId });
  }

  /** Flush local remote audio before the cancellation packet is sent. */
  bargeIn(reason = "speech_detected"): void {
    const turnId = this.snapshot.activeTurnId;
    void this.transport.stopRemoteAudio();
    void nativeAudio.flushPlayback();
    void this.transport.endPushToTalk();
    this.logTelemetry("barge_in", turnId ?? "session");
    this.dispatchCommand({ type: "barge_in", reason });
    if (turnId && this.realtime) this.transport.sendControl({ type: "turn.cancel", sessionId: this.realtime.sessionId, turnId, reason });
  }

  receive(raw: unknown): void {
    if (!isVoiceEvent(raw)) return;
    try {
      this.snapshot = reduceVoiceEvent(this.snapshot, raw);
      this.notify();
    } catch {
      this.snapshot = { ...this.snapshot, state: "ERROR", lastError: { code: "protocol", message: "Invalid voice event" } };
      this.notify();
    }
  }

  async close(): Promise<void> {
    await this.transport.close();
    await nativeAudio.stopSession();
    this.dispatchCommand({ type: "reset" });
  }

  private dispatchCommand(command: Parameters<typeof reduceVoiceCommand>[1]): void {
    try {
      this.snapshot = reduceVoiceCommand(this.snapshot, command);
      this.notify();
    } catch {
      this.snapshot = { ...this.snapshot, state: "ERROR", lastError: { code: "state_transition", message: "Voice session entered an invalid state" } };
      this.notify();
    }
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener(this.snapshot));
  }

  private logTelemetry(name: string, turnId = this.snapshot.activeTurnId ?? "session"): void {
    console.info("[voice.turn]", JSON.stringify({ name, turnId, atMs: Date.now() }));
  }
}

function isVoiceEvent(value: unknown): value is VoiceEvent {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return candidate.protocol === "voice.v1"
    && typeof candidate.type === "string"
    && typeof candidate.sessionId === "string"
    && typeof candidate.turnId === "string";
}

function isSessionReady(value: unknown, sessionId: string | undefined): boolean {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return candidate.protocol === "voice.v1" && candidate.type === "session.ready" && candidate.sessionId === sessionId;
}
