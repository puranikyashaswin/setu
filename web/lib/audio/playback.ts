/** Single-flight TTS playback via HTMLAudioElement only (volume = 1). */

import { voiceClientLog } from "@/lib/debug";
import { createPlaybackQueue, type PlaybackQueue } from "@/lib/audio/playback-queue";
import {
  beginAssistantTts,
  endAssistantTts,
  finalizePlayback,
  getTtsVolume,
  isAssistantSpeaking,
  setAudioOwnerLogger,
  stopNonTtsAudio,
  type PlaybackOutcome,
} from "@/lib/audio/audio-owner";

setAudioOwnerLogger(voiceClientLog);

export type PlaybackHandles = {
  stop: (outcome?: PlaybackOutcome) => void;
  turnId: number;
};

export type PlayElementOptions = {
  arrayBuffer: ArrayBuffer;
  onPlay?: () => void;
  /** Fired exactly once via finalizePlayback — natural | interrupted | cancelled | error. */
  onSettled?: (outcome: PlaybackOutcome) => void;
  /** @deprecated use onSettled — kept as natural-end alias */
  onEnded?: () => void;
  onAmplitude?: (amplitude: number, bands: { bass: number; treble: number }, spectrum: number[]) => void;
  turnId?: number;
};

type ActiveElement = {
  audio: HTMLAudioElement;
  url: string;
  raf: number;
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
  try {
    current.audio.onended = null;
    current.audio.onerror = null;
    current.audio.pause();
    current.audio.removeAttribute("src");
    current.audio.load();
  } catch {
    /* ignore */
  }
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
  });
  settle?.(outcome);
}

/** Stop active TTS and settle as cancelled/interrupted (exactly once). */
export function stopAllPlayback(outcome: PlaybackOutcome = "cancelled"): void {
  if (activeTurnId == null && !activeQueue && !activeElement) {
    stopNonTtsAudio("stop_all_idle");
    return;
  }
  settleActive(outcome);
}

async function playOnePart(
  arrayBuffer: ArrayBuffer,
  onAmplitude?: PlayElementOptions["onAmplitude"],
): Promise<"natural" | "stopped"> {
  return new Promise<"natural" | "stopped">((resolve, reject) => {
    if (activeElement) stopActiveElement();

    const blob = new Blob([arrayBuffer], { type: "audio/wav" });
    const url = URL.createObjectURL(blob);
    const audio = new Audio();
    audio.preload = "auto";
    // Explicit unity volume — never duck TTS on mobile play-and-record residue.
    audio.volume = 1;
    audio.src = url;

    const session: ActiveElement = { audio, url, raf: 0, stopped: false };
    activeElement = session;

    const animate = () => {
      if (session.stopped || activeElement !== session) return;
      if (audio.volume !== 1) audio.volume = 1;
      // Soft pulse for orb viz — HTMLAudioElement path has no AnalyserNode.
      const t = audio.currentTime || 0;
      const amp = 0.32 + 0.28 * Math.abs(Math.sin(t * 7));
      onAmplitude?.(
        amp,
        { bass: amp * 0.85, treble: amp * 0.55 },
        Array.from({ length: 8 }, (_, index) => amp * (0.45 + 0.55 * Math.abs(Math.sin(t * 5 + index)))),
      );
      session.raf = requestAnimationFrame(animate);
    };

    audio.onended = () => {
      if (session.stopped) {
        resolve("stopped");
        return;
      }
      session.stopped = true;
      cancelAnimationFrame(session.raf);
      if (activeElement === session) activeElement = null;
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* ignore */
      }
      resolve("natural");
    };

    audio.onerror = () => {
      session.stopped = true;
      cancelAnimationFrame(session.raf);
      if (activeElement === session) activeElement = null;
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* ignore */
      }
      reject(new Error("HTMLAudioElement playback failed"));
    };

    animate();
    void audio.play().then(() => {
      // Keep volume pinned after play() in case the browser reset it.
      audio.volume = getTtsVolume();
    }).catch((error) => {
      session.stopped = true;
      cancelAnimationFrame(session.raf);
      if (activeElement === session) activeElement = null;
      reject(error);
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
  console.info(`[audio] tts_volume=${getTtsVolume()} turn_id=${turnId} path=html_audio`);

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
          path: "html_audio",
        });
        if (part === 1) onPlay?.();
        const partResult = await playOnePart(arrayBuffers[i], onAmplitude);
        if (stopOutcome || activeQueue !== queue) return;
        if (partResult === "stopped") return;
        const done = queue.endPart(true);
        if (done) {
          settleOnce("natural");
          return;
        }
      }
    } catch {
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

/** Test helper */
export function __resetPlaybackForTests(): void {
  activeSettle = null;
  activeTurnId = null;
  activeQueue = null;
  stopActiveElement();
  revokeUrls(activeObjectUrls);
  activeObjectUrls = [];
  turnCounter = 0;
  endAssistantTts();
}

export { stopNonTtsAudio, beginAssistantTts, finalizePlayback, isAssistantSpeaking } from "./audio-owner";
export type { PlaybackOutcome } from "./audio-owner";
