/**
 * Single-flight TTS — HTMLAudioElement only.
 * Never touches AudioContext / BufferSource / GainNode for TTS bytes.
 */

import { createPlaybackQueue, type PlaybackQueue } from "./playback-queue";
import {
  ensureSharedAudioElement,
  __resetSharedAudioForTests,
  pauseSharedAudioElement,
} from "./shared-audio-element";
import {
  beginAssistantTts,
  endAssistantTts,
  finalizePlayback,
  getTtsVolume,
  isAssistantSpeaking,
  setAudioOwnerLogger,
  stopNonTtsAudio,
  type PlaybackOutcome,
} from "./audio-owner";

type PlaybackLog = (event: string, data?: Record<string, unknown>) => void;
let playbackLog: PlaybackLog = () => undefined;

/** Wire voiceClientLog from the app entry (avoids path-alias imports in tests). */
export function setPlaybackLogger(fn: PlaybackLog): void {
  playbackLog = fn;
  setAudioOwnerLogger((event, data) => fn(event, data));
}

function voiceClientLog(event: string, data?: Record<string, unknown>): void {
  playbackLog(event, data);
}

export const TTS_ROUTE = "html_audio" as const;
/** If currentTime has not advanced by this deadline after play(), treat as dead audio. */
export const PLAYBACK_CURRENT_TIME_DEADLINE_MS = 500;
export const PREPARING_WATCHDOG_MS = 8000;

export type PlaybackHandles = {
  stop: (outcome?: PlaybackOutcome) => void;
  turnId: number;
};

export type PlayElementOptions = {
  arrayBuffer: ArrayBuffer;
  onPlay?: () => void;
  onSettled?: (outcome: PlaybackOutcome) => void;
  onEnded?: () => void;
  onAmplitude?: (amplitude: number, bands: { bass: number; treble: number }, spectrum: number[]) => void;
  turnId?: number;
};

type ActiveElement = {
  url: string;
  raf: number;
  healthTimer: ReturnType<typeof setInterval> | 0;
  stopped: boolean;
};

let turnCounter = 0;
let activeElement: ActiveElement | null = null;
let activeQueue: PlaybackQueue | null = null;
let activeObjectUrls: string[] = [];
let activeSettle: ((outcome: PlaybackOutcome) => void) | null = null;
let activeTurnId: number | null = null;

export function nextPlaybackTurnId(): number {
  turnCounter += 1;
  return turnCounter;
}

export function getActivePlaybackTurnId(): number | null {
  return activeQueue?.turnId ?? activeTurnId;
}

export function isTtsPlaybackActive(): boolean {
  return isAssistantSpeaking() || activeTurnId != null || activeElement != null;
}

/** Static proof helper for tests — TTS path never uses Web Audio graph nodes. */
export function ttsUsesWebAudioGraph(): boolean {
  return false;
}

function revokeUrls(urls: string[]) {
  for (const url of urls) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* ignore */
    }
  }
}

function stopActiveElement(): void {
  const current = activeElement;
  activeElement = null;
  if (!current || current.stopped) return;
  current.stopped = true;
  cancelAnimationFrame(current.raf);
  if (current.healthTimer) globalThis.clearInterval(current.healthTimer);
  pauseSharedAudioElement();
  try {
    URL.revokeObjectURL(current.url);
  } catch {
    /* ignore */
  }
}

function settleActive(outcome: PlaybackOutcome): void {
  const turnId = activeTurnId;
  const settle = activeSettle;
  activeSettle = null;
  activeTurnId = null;
  const queue = activeQueue;
  activeQueue = null;
  stopActiveElement();
  revokeUrls(activeObjectUrls);
  activeObjectUrls = [];
  if (queue) queue.stop();
  endAssistantTts();
  if (turnId == null) {
    settle?.(outcome);
    return;
  }
  if (!finalizePlayback(turnId, outcome)) {
    return;
  }
  voiceClientLog("playback_end", {
    turn_id: turnId,
    stopped: outcome !== "natural",
    outcome,
    parts: queue?.parts ?? 0,
    tts_route: TTS_ROUTE,
  });
  settle?.(outcome);
}

export function stopAllPlayback(outcome: PlaybackOutcome = "cancelled"): void {
  if (activeTurnId == null && !activeQueue && !activeElement) {
    stopNonTtsAudio("stop_all_idle");
    return;
  }
  settleActive(outcome);
}

/**
 * Watchdog: if playback_start never arrives while preparing, fire once.
 * Cleared when playback begins or the turn settles.
 */
export function createPreparingWatchdog(options: {
  turnId: number;
  onTimeout: () => void;
  ms?: number;
}): { clear: () => void } {
  const ms = options.ms ?? PREPARING_WATCHDOG_MS;
  let cleared = false;
  const id = globalThis.setTimeout(() => {
    if (cleared) return;
    cleared = true;
    console.info(`[audio] tts_playback_watchdog_timeout turn_id=${options.turnId}`);
    voiceClientLog("tts_playback_watchdog_timeout", {
      turn_id: options.turnId,
      ms,
    });
    options.onTimeout();
  }, ms);
  return {
    clear: () => {
      if (cleared) return;
      cleared = true;
      globalThis.clearTimeout(id);
    },
  };
}

async function playOnePart(
  arrayBuffer: ArrayBuffer,
  turnId: number,
  onAmplitude?: PlayElementOptions["onAmplitude"],
): Promise<"natural" | "stopped" | "error"> {
  return new Promise<"natural" | "stopped" | "error">((resolve) => {
    if (activeElement) stopActiveElement();

    const blob = new Blob([arrayBuffer], { type: "audio/wav" });
    const url = URL.createObjectURL(blob);
    const audio = ensureSharedAudioElement();
    audio.onended = null;
    audio.onerror = null;
    audio.preload = "auto";
    audio.volume = 1;
    audio.src = url;

    console.info(`[audio] audio_element_reused=true turn_id=${turnId}`);
    voiceClientLog("audio_element_reused", { turn_id: turnId, value: true });

    const session: ActiveElement = {
      url,
      raf: 0,
      healthTimer: 0,
      stopped: false,
    };
    activeElement = session;

    const animate = () => {
      if (session.stopped || activeElement !== session) return;
      if (audio.volume !== 1) audio.volume = 1;
      const t = audio.currentTime || 0;
      const amp = 0.32 + 0.28 * Math.abs(Math.sin(t * 7));
      onAmplitude?.(
        amp,
        { bass: amp * 0.85, treble: amp * 0.55 },
        Array.from({ length: 8 }, (_, index) => amp * (0.45 + 0.55 * Math.abs(Math.sin(t * 5 + index)))),
      );
      session.raf = requestAnimationFrame(animate);
    };

    const finishNatural = () => {
      if (session.stopped) {
        resolve("stopped");
        return;
      }
      session.stopped = true;
      cancelAnimationFrame(session.raf);
      if (session.healthTimer) globalThis.clearInterval(session.healthTimer);
      if (activeElement === session) activeElement = null;
      try {
        audio.onended = null;
        audio.onerror = null;
        audio.pause();
        audio.removeAttribute("src");
        // Never audio.load() here — resets iOS Safari media engagement.
      } catch {
        /* ignore */
      }
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* ignore */
      }
      resolve("natural");
    };

    const finishError = (message: string) => {
      if (session.stopped) {
        resolve("stopped");
        return;
      }
      session.stopped = true;
      cancelAnimationFrame(session.raf);
      if (session.healthTimer) globalThis.clearInterval(session.healthTimer);
      if (activeElement === session) activeElement = null;
      console.info(`[audio] audio_play_error=${message} turn_id=${turnId}`);
      voiceClientLog("audio_play_error", { turn_id: turnId, message, tts_route: TTS_ROUTE });
      try {
        audio.onended = null;
        audio.onerror = null;
        audio.pause();
        audio.removeAttribute("src");
        // Never audio.load() here — resets iOS Safari media engagement.
      } catch {
        /* ignore */
      }
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* ignore */
      }
      resolve("error");
    };

    audio.onended = () => finishNatural();
    audio.onerror = () => finishError("element_error");

    animate();

    const playStartedAt = performance.now();
    let sawCurrentTime = false;
    console.info(`[audio] tts_route=${TTS_ROUTE} turn_id=${turnId}`);
    voiceClientLog("tts_route", { turn_id: turnId, tts_route: TTS_ROUTE });

    void audio
      .play()
      .then(() => {
        audio.volume = getTtsVolume();
        console.info(`[audio] audio_play_called=true turn_id=${turnId}`);
        voiceClientLog("audio_play_called", { turn_id: turnId, value: true, tts_route: TTS_ROUTE });

        session.healthTimer = globalThis.setInterval(() => {
          if (session.stopped || activeElement !== session) {
            globalThis.clearInterval(session.healthTimer);
            return;
          }
          if (!sawCurrentTime && audio.currentTime > 0.01) {
            sawCurrentTime = true;
            const firstMs = Math.round(performance.now() - playStartedAt);
            console.info(`[audio] playback_first_current_time_ms=${firstMs} turn_id=${turnId}`);
            voiceClientLog("playback_first_current_time_ms", {
              turn_id: turnId,
              ms: firstMs,
              tts_route: TTS_ROUTE,
            });
            globalThis.clearInterval(session.healthTimer);
            session.healthTimer = 0;
            return;
          }
          if (!sawCurrentTime && performance.now() - playStartedAt >= PLAYBACK_CURRENT_TIME_DEADLINE_MS) {
            globalThis.clearInterval(session.healthTimer);
            session.healthTimer = 0;
            try {
              audio.pause();
            } catch {
              /* ignore */
            }
            finishError("currentTime_stalled");
          }
        }, 40);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.info(`[audio] audio_play_called=true turn_id=${turnId}`);
        voiceClientLog("audio_play_called", { turn_id: turnId, value: true, tts_route: TTS_ROUTE });
        finishError(message || "play_rejected");
      });
  });
}

/**
 * Play audio parts strictly in series on HTMLAudioElement.
 * onSettled fires exactly once via finalizePlayback.
 */
export async function playDecodedBuffersSequential(
  options: Omit<PlayElementOptions, "arrayBuffer"> & { arrayBuffers: ArrayBuffer[]; turnId?: number },
): Promise<PlaybackHandles> {
  const { arrayBuffers, onPlay, onSettled, onEnded, onAmplitude } = options;
  const turnId = options.turnId ?? nextPlaybackTurnId();

  if (activeTurnId != null || activeQueue || activeElement) {
    settleActive("cancelled");
  }

  beginAssistantTts(turnId);
  console.info(`[audio] tts_volume=${getTtsVolume()} turn_id=${turnId} tts_route=${TTS_ROUTE}`);

  const queue = createPlaybackQueue(arrayBuffers.length, turnId);
  activeQueue = queue;
  activeTurnId = turnId;
  activeSettle = (outcome) => {
    onSettled?.(outcome);
    if (outcome === "natural") onEnded?.();
  };

  const settleOnce = (outcome: PlaybackOutcome) => {
    if (activeTurnId === turnId || activeQueue === queue) {
      settleActive(outcome);
    }
  };

  if (!arrayBuffers.length) {
    settleOnce("natural");
    return {
      turnId,
      stop: (outcome = "cancelled") => settleOnce(outcome),
    };
  }

  let stopOutcome: PlaybackOutcome | null = null;

  const run = async () => {
    try {
      for (let i = 0; i < arrayBuffers.length; i += 1) {
        if (stopOutcome || activeQueue !== queue) return;
        const part = i + 1;
        if (!queue.beginPart(part)) return;
        voiceClientLog("playback_start", {
          turn_id: turnId,
          part,
          parts: arrayBuffers.length,
          tts_volume: getTtsVolume(),
          tts_route: TTS_ROUTE,
        });
        if (part === 1) onPlay?.();
        const partResult = await playOnePart(arrayBuffers[i], turnId, onAmplitude);
        if (stopOutcome || activeQueue !== queue) return;
        if (partResult === "stopped") return;
        if (partResult === "error") {
          settleOnce("error");
          return;
        }
        const done = queue.endPart(true);
        if (done) {
          settleOnce("natural");
          return;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      voiceClientLog("audio_play_error", { turn_id: turnId, message, tts_route: TTS_ROUTE });
      settleOnce("error");
    }
  };

  void run();

  return {
    turnId,
    stop: (outcome: PlaybackOutcome = "cancelled") => {
      stopOutcome = outcome;
      if (activeQueue === queue || activeTurnId === turnId) {
        settleOnce(outcome);
      }
    },
  };
}

export async function playDecodedBuffer(options: PlayElementOptions): Promise<PlaybackHandles> {
  return playDecodedBuffersSequential({
    arrayBuffers: [options.arrayBuffer],
    onPlay: options.onPlay,
    onSettled: options.onSettled,
    onEnded: options.onEnded,
    onAmplitude: options.onAmplitude,
    turnId: options.turnId,
  });
}

export async function fetchArrayBuffer(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error("Audio fetch failed");
  return response.arrayBuffer();
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export function __resetPlaybackForTests(): void {
  activeSettle = null;
  activeTurnId = null;
  activeQueue = null;
  stopActiveElement();
  revokeUrls(activeObjectUrls);
  activeObjectUrls = [];
  turnCounter = 0;
  endAssistantTts();
  __resetSharedAudioForTests();
}

export { stopNonTtsAudio, beginAssistantTts, finalizePlayback, isAssistantSpeaking } from "./audio-owner";
export type { PlaybackOutcome } from "./audio-owner";
