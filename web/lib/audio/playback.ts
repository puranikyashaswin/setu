/** Single-flight buffer TTS playback — one active source, serial parts. */

import { voiceClientLog } from "@/lib/debug";
import { createPlaybackQueue, type PlaybackQueue } from "@/lib/audio/playback-queue";

export type PlaybackHandles = {
  stop: () => void;
  turnId: number;
};

export type PlayBufferOptions = {
  context: AudioContext;
  arrayBuffer: ArrayBuffer;
  onPlay?: () => void;
  onEnded?: () => void;
  onAmplitude?: (amplitude: number, bands: { bass: number; treble: number }, spectrum: number[]) => void;
  turnId?: number;
};

type ActiveSource = {
  source: AudioBufferSourceNode;
  analyser: AnalyserNode;
  raf: number;
  stopped: boolean;
};

let turnCounter = 0;
let activeSource: ActiveSource | null = null;
let activeQueue: PlaybackQueue | null = null;
let activeObjectUrls: string[] = [];

export function nextPlaybackTurnId(): number {
  turnCounter += 1;
  return turnCounter;
}

export function getActivePlaybackTurnId(): number | null {
  return activeQueue?.turnId ?? null;
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
  } catch {
    /* ignore */
  }
}

/** Stop active audio, clear queued parts, revoke URLs, settle safely. */
export function stopAllPlayback(): void {
  const queue = activeQueue;
  activeQueue = null;
  stopActiveSource();
  revokeUrls(activeObjectUrls);
  activeObjectUrls = [];
  if (queue) {
    queue.stop();
    voiceClientLog("playback_end", { turn_id: queue.turnId, stopped: true, parts: queue.parts });
  }
}

async function playOnePart(
  context: AudioContext,
  arrayBuffer: ArrayBuffer,
  onAmplitude?: PlayBufferOptions["onAmplitude"],
): Promise<void> {
  if (context.state !== "running") {
    try {
      await context.resume();
    } catch {
      /* ignore */
    }
  }

  const audioBuffer = await context.decodeAudioData(arrayBuffer.slice(0));
  if (!activeQueue || activeQueue.active === false && activeSource) {
    /* still ok to continue if queue owns this turn */
  }

  return new Promise<void>((resolve, reject) => {
    // Exactly one active source.
    if (activeSource) stopActiveSource();

    const source = context.createBufferSource();
    source.buffer = audioBuffer;
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    analyser.connect(context.destination);

    const data = new Uint8Array(analyser.frequencyBinCount);
    const session: ActiveSource = { source, analyser, raf: 0, stopped: false };
    activeSource = session;

    const animate = () => {
      if (session.stopped || activeSource !== session) return;
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
        resolve();
        return;
      }
      session.stopped = true;
      cancelAnimationFrame(session.raf);
      try {
        source.disconnect();
        analyser.disconnect();
      } catch {
        /* ignore */
      }
      if (activeSource === session) activeSource = null;
      resolve();
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
 * Play audio parts strictly in series. Resolves handles immediately; onEnded fires
 * only after the final queued part ends. Never starts part 2 until part 1 ended.
 */
export async function playDecodedBuffersSequential(
  options: Omit<PlayBufferOptions, "arrayBuffer"> & { arrayBuffers: ArrayBuffer[]; turnId?: number },
): Promise<PlaybackHandles> {
  const { arrayBuffers, onPlay, onEnded, onAmplitude, context } = options;
  const turnId = options.turnId ?? nextPlaybackTurnId();

  stopAllPlayback();

  const queue = createPlaybackQueue(arrayBuffers.length, turnId);
  activeQueue = queue;

  if (!arrayBuffers.length) {
    onEnded?.();
    return { turnId, stop: () => stopAllPlayback() };
  }

  let cancelled = false;

  const run = async () => {
    for (let i = 0; i < arrayBuffers.length; i += 1) {
      if (cancelled || activeQueue !== queue) return;
      const part = i + 1;
      if (!queue.beginPart(part)) return;
      voiceClientLog("playback_start", { turn_id: turnId, part, parts: arrayBuffers.length });
      if (part === 1) onPlay?.();
      try {
        await playOnePart(context, arrayBuffers[i], onAmplitude);
      } catch {
        queue.stop();
        if (activeQueue === queue) activeQueue = null;
        return;
      }
      if (cancelled || activeQueue !== queue) return;
      const done = queue.endPart(true);
      voiceClientLog("playback_end", {
        turn_id: turnId,
        part,
        parts: arrayBuffers.length,
        natural: true,
      });
      if (done) {
        if (activeQueue === queue) activeQueue = null;
        onEnded?.();
        return;
      }
    }
  };

  void run();

  return {
    turnId,
    stop: () => {
      cancelled = true;
      if (activeQueue === queue) stopAllPlayback();
    },
  };
}

export async function playDecodedBuffer(options: PlayBufferOptions): Promise<PlaybackHandles> {
  return playDecodedBuffersSequential({
    context: options.context,
    arrayBuffers: [options.arrayBuffer],
    onPlay: options.onPlay,
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
  stopAllPlayback();
  turnCounter = 0;
  activeQueue = null;
  activeSource = null;
  activeObjectUrls = [];
}
