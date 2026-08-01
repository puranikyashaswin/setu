/** Buffer-based TTS playback — avoids iOS MediaElementSource silence bugs. */

import { voiceClientLog } from "@/lib/debug";

export type PlaybackHandles = {
  stop: () => void;
};

export type PlayBufferOptions = {
  context: AudioContext;
  arrayBuffer: ArrayBuffer;
  onPlay?: () => void;
  onEnded?: () => void;
  onAmplitude?: (amplitude: number, bands: { bass: number; treble: number }, spectrum: number[]) => void;
};

export async function playDecodedBuffersSequential(
  options: Omit<PlayBufferOptions, "arrayBuffer"> & { arrayBuffers: ArrayBuffer[] },
): Promise<PlaybackHandles> {
  const { arrayBuffers, ...rest } = options;
  if (!arrayBuffers.length) {
    return { stop: () => undefined };
  }
  let current: PlaybackHandles | null = null;
  let stopped = false;
  let index = 0;

  const playNext = async (): Promise<void> => {
    if (stopped || index >= arrayBuffers.length) {
      if (!stopped) rest.onEnded?.();
      return;
    }
    const isFirst = index === 0;
    const buffer = arrayBuffers[index];
    index += 1;
    current = await playDecodedBuffer({
      ...rest,
      arrayBuffer: buffer,
      onPlay: isFirst ? rest.onPlay : undefined,
      onEnded: () => {
        void playNext();
      },
    });
  };

  await playNext();
  return {
    stop: () => {
      stopped = true;
      current?.stop();
    },
  };
}

export async function playDecodedBuffer(options: PlayBufferOptions): Promise<PlaybackHandles> {
  const { context, arrayBuffer, onPlay, onEnded, onAmplitude } = options;
  if (context.state !== "running") {
    try {
      await context.resume();
    } catch {
      /* watchdog / caller handles failure */
    }
  }

  const audioBuffer = await context.decodeAudioData(arrayBuffer.slice(0));
  const source = context.createBufferSource();
  source.buffer = audioBuffer;
  const analyser = context.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);
  analyser.connect(context.destination);

  let raf = 0;
  let stopped = false;
  let endLogged = false;
  const data = new Uint8Array(analyser.frequencyBinCount);

  const animate = () => {
    if (stopped) return;
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
    raf = requestAnimationFrame(animate);
  };

  const logEnd = () => {
    if (endLogged) return;
    endLogged = true;
    voiceClientLog("playback_end");
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(raf);
    try {
      source.stop();
    } catch {
      /* already stopped */
    }
    try {
      source.disconnect();
      analyser.disconnect();
    } catch {
      /* ignore */
    }
    logEnd();
  };

  source.onended = () => {
    stop();
    onEnded?.();
  };

  voiceClientLog("playback_start");
  onPlay?.();
  animate();
  source.start(0);

  return { stop };
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
