/** Listen while TTS plays — fire when the user starts talking (barge-in). */

import { SPEECH_LEVEL } from "@/lib/audio/recorder";
import { debugLog, voiceClientLog } from "@/lib/debug";

export type BargeInMonitor = {
  stop: () => void;
};

const IGNORE_MS = 900; // ignore speaker bleed right after TTS starts
/** Sustained user voice required to interrupt; shorter echo/noise bursts ignored. */
export const BARGE_IN_CONFIRM_MS = 350;

export async function startBargeInMonitor(
  context: AudioContext,
  onBargeIn: () => void,
): Promise<BargeInMonitor> {
  if (context.state !== "running") {
    try {
      await context.resume();
    } catch {
      /* ignore */
    }
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);

  const data = new Uint8Array(analyser.fftSize);
  const startedAt = performance.now();
  let stopped = false;
  let loudSince = 0;
  let raf = 0;

  const tick = () => {
    if (stopped) return;
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i += 1) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / data.length);
    const elapsed = performance.now() - startedAt;
    if (elapsed < IGNORE_MS) {
      raf = requestAnimationFrame(tick);
      return;
    }
    // Higher threshold — laptop/phone speakers often trip barge-in and kill the mic loop.
    if (rms >= SPEECH_LEVEL * 2.4) {
      if (loudSince === 0) loudSince = performance.now();
      if (performance.now() - loudSince >= BARGE_IN_CONFIRM_MS) {
        debugLog("[barge-in] detected", { rms: rms.toFixed(4) });
        voiceClientLog("barge_in_detected", { rms: Number(rms.toFixed(4)), sustained_ms: BARGE_IN_CONFIRM_MS });
        stop();
        onBargeIn();
        return;
      }
    } else {
      loudSince = 0;
    }
    raf = requestAnimationFrame(tick);
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(raf);
    try {
      source.disconnect();
      analyser.disconnect();
    } catch {
      /* ignore */
    }
    stream.getTracks().forEach((track) => track.stop());
  };

  raf = requestAnimationFrame(tick);
  return { stop };
}
