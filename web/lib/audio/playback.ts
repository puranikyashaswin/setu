/** Single-flight buffer TTS playback — one active source, serial parts. */

import { voiceClientLog } from "@/lib/debug";
import { createPlaybackQueue, type PlaybackQueue } from "@/lib/audio/playback-queue";
import {
  beginAssistantTts,
  endAssistantTts,
  finalizePlayback,
  getTtsVolume,
  setAudioOwnerLogger,
  stopNonTtsAudio,
  type PlaybackOutcome,
} from "@/lib/audio/audio-owner";

setAudioOwnerLogger(voiceClientLog);

export type PlaybackHandles = {
  stop: (outcome?: PlaybackOutcome) => void;
  turnId: number;
};

export type PlayBufferOptions = {
  context: AudioContext;
  arrayBuffer: ArrayBuffer;
  onPlay?: () => void;
  /** Fired exactly once via finalizePlayback — natural | interrupted | cancelled | error. */
  onSettled?: (outcome: PlaybackOutcome) => void;
  /** @deprecated use onSettled — kept as natural-end alias */
  onEnded?: () => void;
  onAmplitude?: (amplitude: number, bands: { bass: number; treble: number }, spectrum: number[]) => void;
  turnId?: number;
};

type ActiveSource = {
  source: AudioBufferSourceNode;
  analyser: AnalyserNode;
  gain: GainNode;
  raf: number;
  stopped: boolean;
};

let turnCounter = 0;
let activeSource: ActiveSource | null = null;
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

function revokeUrls(urls: string[]) {
  for (const url of urls) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* ignore */
    }
  }
}

function stopActiveSource(): void {
  const current = activeSource;
  activeSource = null;
  if (!current || current.stopped) return;
  current.stopped = true;
  cancelAnimationFrame(current.raf);
  try {
    current.source.stop();
  } catch {
    /* already stopped */
  }
  try {
    current.source.disconnect();
    current.analyser.disconnect();
    current.gain.disconnect();
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
  stopActiveSource();
  revokeUrls(activeObjectUrls);
  activeObjectUrls = [];
  if (queue) queue.stop();
  endAssistantTts();
  if (turnId == null) {
    settle?.(outcome);
    return;
  }
  if (!finalizePlayback(turnId, outcome)) {
    // Already finalized — do not double-fire page handlers.
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
  if (activeTurnId == null && !activeQueue && !activeSource) {
    stopNonTtsAudio("stop_all_idle");
    return;
  }
  settleActive(outcome);
}

async function playOnePart(
  context: AudioContext,
  arrayBuffer: ArrayBuffer,
  onAmplitude?: PlayBufferOptions["onAmplitude"],
): Promise<"natural" | "stopped"> {
  if (context.state !== "running") {
    try {
      await context.resume();
    } catch {
      /* ignore */
    }
  }

  const audioBuffer = await context.decodeAudioData(arrayBuffer.slice(0));

  return new Promise<"natural" | "stopped">((resolve, reject) => {
    if (activeSource) stopActiveSource();

    const source = context.createBufferSource();
    source.buffer = audioBuffer;
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    const gain = context.createGain();
    // Explicit unity gain — never duck TTS.
    gain.gain.value = getTtsVolume();
    source.connect(analyser);
    analyser.connect(gain);
    gain.connect(context.destination);

    const data = new Uint8Array(analyser.frequencyBinCount);
    const session: ActiveSource = { source, analyser, gain, raf: 0, stopped: false };
    activeSource = session;

    const animate = () => {
      if (session.stopped || activeSource !== session) return;
      // Keep gain pinned at 1.0 for the life of the part.
      if (gain.gain.value !== 1) gain.gain.value = 1;
      analyser.getByteFrequencyData(data);
      const normal = (from: number, to: number) =>
        data.slice(from, to).reduce((sum, value) => sum + value, 0) / Math.max(1, to - from) / 255;
      const amplitude = data.reduce((sum, value) => sum + value, 0) / data.length / 255;
      onAmplitude?.(
        amplitude,
        {
          bass: normal(0, Math.floor(data.length * 0.18)),
          treble: normal(Math.floor(data.length * 0.62), data.length),
        },
        Array.from({ length: 8 }, (_, index) =>
          normal(Math.floor((data.length * index) / 8), Math.floor((data.length * (index + 1)) / 8)),
        ),
      );
      session.raf = requestAnimationFrame(animate);
    };

    source.onended = () => {
      if (session.stopped) {
        resolve("stopped");
        return;
      }
      session.stopped = true;
      cancelAnimationFrame(session.raf);
      try {
        source.disconnect();
        analyser.disconnect();
        gain.disconnect();
      } catch {
        /* ignore */
      }
      if (activeSource === session) activeSource = null;
      resolve("natural");
    };

    animate();
    try {
      source.start(0);
    } catch (error) {
      session.stopped = true;
      if (activeSource === session) activeSource = null;
      reject(error);
    }
  });
}

/**
 * Play audio parts strictly in series. onSettled fires exactly once
 * (natural end, stop/interrupt, or error) via finalizePlayback.
 */
export async function playDecodedBuffersSequential(
  options: Omit<PlayBufferOptions, "arrayBuffer"> & { arrayBuffers: ArrayBuffer[]; turnId?: number },
): Promise<PlaybackHandles> {
  const { arrayBuffers, onPlay, onSettled, onEnded, onAmplitude, context } = options;
  const turnId = options.turnId ?? nextPlaybackTurnId();

  // Cancel any prior turn cleanly before owning the bus.
  if (activeTurnId != null || activeQueue || activeSource) {
    settleActive("cancelled");
  }

  beginAssistantTts(turnId);
  console.info(`[audio] tts_volume=${getTtsVolume()} turn_id=${turnId}`);

  const queue = createPlaybackQueue(arrayBuffers.length, turnId);
  activeQueue = queue;
  activeTurnId = turnId;
  activeSettle = (outcome) => {
    onSettled?.(outcome);
    if (outcome === "natural") onEnded?.();
  };

  const settleOnce = (outcome: PlaybackOutcome) => {
    if (activeTurnId !== turnId && activeSettle == null && !activeQueue) {
      // Already settled.
      return;
    }
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
        });
        if (part === 1) onPlay?.();
        const partResult = await playOnePart(context, arrayBuffers[i], onAmplitude);
        if (stopOutcome || activeQueue !== queue) return;
        if (partResult === "stopped") {
          // stopAllPlayback / settleActive already ran.
          return;
        }
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

export async function playDecodedBuffer(options: PlayBufferOptions): Promise<PlaybackHandles> {
  return playDecodedBuffersSequential({
    context: options.context,
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
  stopActiveSource();
  revokeUrls(activeObjectUrls);
  activeObjectUrls = [];
  turnCounter = 0;
  endAssistantTts();
}

// Re-export owner helpers used by page/tests.
export { stopNonTtsAudio, beginAssistantTts, finalizePlayback, attemptNonTtsSound } from "./audio-owner";
export type { PlaybackOutcome } from "./audio-owner";
