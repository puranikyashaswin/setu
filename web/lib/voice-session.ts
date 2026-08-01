/** Persistent voice WebSocket client with progressive audio + cancel (barge-in). */

import { API_URL, type ApiHistoryMessage, type VoiceTurnResponse } from "@/lib/api";
import { getStoredUserId } from "@/lib/auth";
import { debugLog, installDebugHelpers, voiceClientLog } from "@/lib/debug";

installDebugHelpers();

export type VoiceSessionConfig = {
  language: string;
  hasDocument: boolean;
  docId?: string | null;
  history: ApiHistoryMessage[];
  memory?: string | null;
  sessionId?: string | null;
  onboarded: boolean;
  pace: number;
};

export type VoiceSessionHandlers = {
  onStatus?: (stage: string, text: string) => void;
  onTranscript?: (text: string, languageCode?: string) => void;
  onAudioPart?: (part: { audioBase64: string; index: number; text?: string; final: boolean }) => void;
  onTool?: (name: string) => void;
  onError?: (message: string) => void;
};

type PendingTurn = {
  resolve: (value: VoiceTurnResponse) => void;
  reject: (error: Error) => void;
  parts: string[];
  handlers: VoiceSessionHandlers;
};

function wsBaseUrl(): string {
  const http = API_URL.replace(/\/$/, "");
  if (http.startsWith("https://")) return `wss://${http.slice("https://".length)}`;
  if (http.startsWith("http://")) return `ws://${http.slice("http://".length)}`;
  return `ws://${http}`;
}

export class VoiceSession {
  private socket: WebSocket | null = null;
  private ready = false;
  private connecting: Promise<void> | null = null;
  private pending: PendingTurn | null = null;
  private config: VoiceSessionConfig | null = null;
  private everConnected = false;
  private connectGeneration = 0;
  /** server_vad_v1 state (legacy_client: always false). */
  vadReady = false;
  vadEngine: string | null = null;
  serverTurnMode: string | null = null;
  private vadReadyWaiter: ((ready: boolean) => void) | null = null;
  private vadEventHandler: ((msg: Record<string, unknown>) => void) | null = null;
  private lifecycleHandler:
    | { onVadReady?: (engine: string) => void; onModeMismatch?: (serverMode: string) => void; onSocketDrop?: () => void }
    | null = null;

  get isOpen(): boolean {
    return Boolean(this.socket && this.socket.readyState === WebSocket.OPEN && this.ready);
  }

  async connect(sessionId?: string | null): Promise<boolean> {
    if (this.isOpen) return true;
    if (this.connecting) {
      await this.connecting;
      return this.isOpen;
    }
    const userId = getStoredUserId();
    if (!userId) return false;

    if (this.everConnected) {
      this.connectGeneration += 1;
      voiceClientLog("ws_reconnect_attempt", { attempt: this.connectGeneration });
    }

    const sid = (sessionId || this.config?.sessionId || "").trim();
    this.connecting = new Promise<void>((resolve) => {
      const params = new URLSearchParams({ user_id: userId });
      if (sid) params.set("session_id", sid);
      const url = `${wsBaseUrl()}/ws/voice?${params.toString()}`;
      const socket = new WebSocket(url);
      this.socket = socket;
      let settled = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        this.connecting = null;
        resolve();
      };

      const timer = window.setTimeout(() => {
        debugLog("[voice-session] connect timeout");
        voiceClientLog("ws_error", { detail: "connect_timeout" });
        try {
          socket.close();
        } catch {
          /* ignore */
        }
        finish();
      }, 4000);

      socket.onopen = () => {
        debugLog("[voice-session] open");
      };

      socket.onmessage = (event) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(event.data)) as Record<string, unknown>;
        } catch {
          return;
        }
        const type = String(msg.type || "");
        if (type === "ready") {
          this.ready = true;
          this.everConnected = true;
          this.serverTurnMode = typeof msg.voice_turn_mode === "string" ? msg.voice_turn_mode : null;
          this.vadEngine = typeof msg.vad_engine === "string" ? msg.vad_engine : null;
          voiceClientLog("ws_connect", { voice_turn_mode: this.serverTurnMode });
          window.clearTimeout(timer);
          finish();
          return;
        }
        if (type === "voice_v2_ready") {
          this.vadReady = true;
          this.vadEngine = typeof msg.vad_engine === "string" ? msg.vad_engine : this.vadEngine;
          const waiter = this.vadReadyWaiter;
          this.vadReadyWaiter = null;
          waiter?.(true);
          this.lifecycleHandler?.onVadReady?.(this.vadEngine || "");
          return;
        }
        if (type === "mode_not_implemented") {
          const mode = typeof msg.mode === "string" ? msg.mode : "unknown";
          voiceClientLog("mode_not_implemented", { mode });
          this.lifecycleHandler?.onModeMismatch?.(mode);
          return;
        }
        if (
          type === "vad_speech_start"
          || type === "vad_speech_end_candidate"
          || type === "semantic_turn_wait"
          || type === "turn_finalized"
        ) {
          this.vadEventHandler?.(msg);
          return;
        }
        this.handleMessage(msg);
      };

      socket.onerror = () => {
        debugLog("[voice-session] error");
        voiceClientLog("ws_error", { detail: "socket_error" });
        window.clearTimeout(timer);
        this.ready = false;
        finish();
      };

      socket.onclose = (ev) => {
        debugLog("[voice-session] close");
        voiceClientLog("ws_error", {
          detail: "socket_close",
          code: ev.code,
          reason: ev.reason || "",
        });
        window.clearTimeout(timer);
        this.ready = false;
        this.socket = null;
        const wasVadReady = this.vadReady;
        this.vadReady = false;
        if (wasVadReady || this.vadReadyWaiter) {
          const waiter = this.vadReadyWaiter;
          this.vadReadyWaiter = null;
          waiter?.(false);
          this.lifecycleHandler?.onSocketDrop?.();
        }
        if (this.pending) {
          this.pending.reject(new Error("Voice session disconnected"));
          this.pending = null;
        }
        finish();
      };
    });

    await this.connecting;
    return this.isOpen;
  }

  async updateSession(config: VoiceSessionConfig): Promise<void> {
    this.config = config;
    if (!(await this.connect(config.sessionId))) return;
    this.send({
      type: "session.update",
      language: config.language,
      has_document: config.hasDocument,
      doc_id: config.docId ?? null,
      history: config.history,
      memory: config.memory ?? null,
      session_id: config.sessionId ?? null,
      onboarded: config.onboarded,
      pace: config.pace,
    });
  }

  cancel(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.send({ type: "cancel" });
  }

  async runUtterance(
    audio: Blob,
    handlers: VoiceSessionHandlers = {},
    forceRoute?: string | null,
    transcript?: string | null,
  ): Promise<VoiceTurnResponse> {
    if (!(await this.connect())) {
      throw new Error("Voice WebSocket unavailable");
    }
    if (this.config) await this.updateSession(this.config);

    const audioBase64 = await blobToBase64(audio);
    if (this.pending) {
      this.cancel();
      this.pending.reject(new Error("Superseded by new utterance"));
      this.pending = null;
    }

    // Browser STT is display-only early feedback; server Saaras remains authoritative.
    // Do not send browser transcript on the WS turn (avoids duplicate / conflicting text).
    const browserText = transcript?.trim() || "";
    if (browserText) {
      voiceClientLog("transcript", {
        source: "browser-stt",
        text: browserText.slice(0, 120),
        chars: browserText.length,
        display_only: true,
      });
    }

    return new Promise<VoiceTurnResponse>((resolve, reject) => {
      this.pending = { resolve, reject, parts: [], handlers };
      this.send({
        type: "audio.utterance",
        audio_base64: audioBase64,
        force_route: forceRoute ?? null,
      });
    });
  }

  // ---- server_vad_v1 -------------------------------------------------------

  setLifecycleHandler(handler: VoiceSession["lifecycleHandler"]): void {
    this.lifecycleHandler = handler;
  }

  setVadEventHandler(handler: ((msg: Record<string, unknown>) => void) | null): void {
    this.vadEventHandler = handler;
  }

  /** Wait ONCE (per call) for voice_v2_ready, up to timeoutMs. */
  whenVadReady(timeoutMs = 1000): Promise<boolean> {
    if (this.vadReady) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = window.setTimeout(() => {
        if (this.vadReadyWaiter) {
          this.vadReadyWaiter = null;
          resolve(false);
        }
      }, timeoutMs);
      this.vadReadyWaiter = (ready) => {
        window.clearTimeout(timer);
        resolve(ready);
      };
    });
  }

  /** Register a pending server-VAD turn; resolves on turn.done like runUtterance. */
  beginServerVadTurn(handlers: VoiceSessionHandlers = {}): Promise<VoiceTurnResponse> {
    if (this.pending) {
      this.pending.reject(new Error("Superseded by new utterance"));
      this.pending = null;
    }
    return new Promise<VoiceTurnResponse>((resolve, reject) => {
      this.pending = { resolve, reject, parts: [], handlers };
    });
  }

  /** Drop a pending server-VAD turn locally (legacy fallback took over). */
  abandonServerVadTurn(): void {
    if (this.pending) {
      this.pending.reject(new Error("cancelled"));
      this.pending = null;
    }
  }

  sendAudioChunk(turnId: number, sequence: number, pcmBase64: string): void {
    this.send({ type: "audio.chunk", turn_id: turnId, sequence, pcm_base64: pcmBase64, sample_rate: 16000 });
  }

  sendPartialTranscript(turnId: number, text: string): void {
    this.send({ type: "partial_transcript", turn_id: turnId, text });
  }

  sendVadClientFallback(turnId: number): void {
    this.send({ type: "vad.client_fallback", turn_id: turnId });
  }

  close(): void {
    this.ready = false;
    try {
      this.socket?.close();
    } catch {
      /* ignore */
    }
    this.socket = null;
    this.pending = null;
  }

  private send(payload: Record<string, unknown>) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(payload));
  }

  private handleMessage(msg: Record<string, unknown>) {
    const type = String(msg.type || "");
    const pending = this.pending;
    if (!pending) return;

    if (type === "status") {
      pending.handlers.onStatus?.(String(msg.stage || ""), String(msg.text || ""));
      return;
    }
    if (type === "transcript") {
      const text = String(msg.text || "");
      voiceClientLog("transcript", {
        source: "server",
        text: text.slice(0, 120),
        language: String(msg.language_code || ""),
      });
      pending.handlers.onTranscript?.(text, String(msg.language_code || ""));
      return;
    }
    if (type === "tool") {
      pending.handlers.onTool?.(String(msg.name || ""));
      return;
    }
    if (type === "audio") {
      const b64 = String(msg.audio_base64 || "");
      if (b64) pending.parts.push(b64);
      const index = Number(msg.index || 0);
      voiceClientLog("audio_part_received", {
        part: index + 1,
        bytes: b64 ? Math.floor((b64.length * 3) / 4) : 0,
      });
      pending.handlers.onAudioPart?.({
        audioBase64: b64,
        index,
        text: typeof msg.text === "string" ? msg.text : undefined,
        final: Boolean(msg.final),
      });
      return;
    }
    if (type === "error") {
      const message = String(msg.message || "Voice turn failed");
      voiceClientLog("ws_error", { detail: message });
      pending.handlers.onError?.(message);
      this.pending = null;
      pending.reject(new Error(message));
      return;
    }
    if (type === "cancelled") {
      this.pending = null;
      pending.reject(new Error("cancelled"));
      return;
    }
    if (type === "turn.done") {
      const audio = pending.parts[0] || String(msg.audio_base64 || "");
      const response = {
        transcript: String(msg.transcript || ""),
        language_code: typeof msg.language_code === "string" ? msg.language_code : undefined,
        language: String(msg.language || "en"),
        route: String(msg.route || "converse"),
        intent: String(msg.intent || "chat"),
        reply: String(msg.reply || ""),
        spoken: String(msg.spoken || ""),
        open_camera: Boolean(msg.open_camera),
        continue_listening: Boolean(msg.continue_listening),
        model_used: typeof msg.model_used === "string" ? msg.model_used : null,
        ask: (msg.ask as VoiceTurnResponse["ask"]) ?? null,
        audio_base64: audio,
        audio_mime: typeof msg.audio_mime === "string" ? msg.audio_mime : "audio/wav",
        audio_parts_base64: pending.parts,
        tools_used: Array.isArray(msg.tools_used) ? (msg.tools_used as string[]) : [],
      } as VoiceTurnResponse & { audio_parts_base64?: string[]; tools_used?: string[] };
      this.pending = null;
      pending.resolve(response);
    }
  }
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

let sharedSession: VoiceSession | null = null;

export function getVoiceSession(): VoiceSession {
  if (!sharedSession) sharedSession = new VoiceSession();
  return sharedSession;
}
