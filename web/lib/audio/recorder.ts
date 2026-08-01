import { debugLog, voiceClientLog } from "@/lib/debug";
import { encodeWav } from "@/lib/audio/wav";
import { ensureVadWorklet, getVadProcessorName } from "@/lib/audio/worklet-vad";

export const SILENCE_MS = 1100;
export const MIN_RECORDING_MS = 900;
export const MAX_RECORDING_MS = 15000;
export const NO_SPEECH_MS = 7000;
export const SPEECH_LEVEL = 0.014;
export const AMBIENT_MS = 350;
/** ~80ms of loud frames at 128-sample worklet quantum (~48kHz). */
export const SPEECH_FRAMES_TO_CONFIRM = 24;
export const MIN_SPEECH_MS = 160;
/** Post-TTS delay before reopening the mic (speakerphone echo). */
export const POST_TTS_RESUME_MS = 700;

export type RecorderSession = {
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  worklet: AudioWorkletNode;
  silenceGain: GainNode;
  chunks: Float32Array[];
  sampleRate: number;
  startedAt: number;
  heardSpeech: boolean;
  silentSince: number | null;
  raf: number;
  speechThreshold: number;
  ambientSum: number;
  ambientCount: number;
  thresholdLocked: boolean;
  speechRunFrames: number;
  speechFrames: number;
  frameMs: number;
  framesSeen: number;
  watchdog: number;
  onFrame?: (info: { rms: number; threshold: number }) => void;
};

export type RecorderCallbacks = {
  onLevel?: (amplitude: number, bands: { bass: number; treble: number }, micLevel: number, threshold: number) => void;
  onAutoStopProgress?: (progress: number) => void;
  onFinish: (cancelled: boolean) => void;
  onWatchdog?: (message: string) => void;
};

let workletReadyFor: AudioContext | null = null;

async function ensureWorklet(context: AudioContext) {
  if (workletReadyFor === context) return;
  await ensureVadWorklet(context);
  workletReadyFor = context;
}

export async function startVoiceRecorder(
  context: AudioContext,
  callbacks: RecorderCallbacks,
): Promise<RecorderSession> {
  await ensureWorklet(context);
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 256;
  const worklet = new AudioWorkletNode(context, getVadProcessorName());
  // Keep the worklet in the graph without audible output (gain 0).
  // Never raise this gain — VAD must stay silent while analyzing.
  const silenceGain = context.createGain();
  silenceGain.gain.value = 0;
  source.connect(analyser);
  source.connect(worklet);
  worklet.connect(silenceGain);
  silenceGain.connect(context.destination);

  const recorder: RecorderSession = {
    stream,
    source,
    analyser,
    worklet,
    silenceGain,
    chunks: [],
    sampleRate: context.sampleRate,
    startedAt: performance.now(),
    heardSpeech: false,
    silentSince: null,
    raf: 0,
    speechThreshold: SPEECH_LEVEL,
    ambientSum: 0,
    ambientCount: 0,
    thresholdLocked: false,
    speechRunFrames: 0,
    speechFrames: 0,
    frameMs: (128 / context.sampleRate) * 1000,
    framesSeen: 0,
    watchdog: 0,
  };

  const meterData = new Uint8Array(analyser.frequencyBinCount);
  const tickMeter = () => {
    analyser.getByteFrequencyData(meterData);
    const normal = (from: number, to: number) =>
      meterData.slice(from, to).reduce((sum, value) => sum + value, 0) / Math.max(1, to - from) / 255;
    const amplitude = meterData.reduce((sum, value) => sum + value, 0) / meterData.length / 255;
    callbacks.onLevel?.(
      Math.max(0.12, amplitude),
      {
        bass: normal(0, Math.floor(meterData.length * 0.18)),
        treble: normal(Math.floor(meterData.length * 0.62), meterData.length),
      },
      amplitude,
      recorder.speechThreshold,
    );
    recorder.raf = requestAnimationFrame(tickMeter);
  };
  recorder.raf = requestAnimationFrame(tickMeter);

  worklet.port.onmessage = (event: MessageEvent) => {
    const data = event.data as { type: string; rms?: number; samples?: Float32Array };
    const now = performance.now();
    const elapsed = now - recorder.startedAt;
    recorder.framesSeen += 1;

    if (data.type === "frame" && data.samples) {
      recorder.chunks.push(data.samples);
      recorder.frameMs = (data.samples.length / recorder.sampleRate) * 1000;
    }

    const rms = data.rms ?? 0;
    if (!recorder.thresholdLocked && elapsed < AMBIENT_MS) {
      recorder.ambientSum += rms;
      recorder.ambientCount += 1;
      if (recorder.ambientCount > 0) {
        const ambient = recorder.ambientSum / recorder.ambientCount;
        recorder.speechThreshold = Math.min(0.05, Math.max(SPEECH_LEVEL, ambient * 2.4 + 0.008));
      }
    } else if (!recorder.thresholdLocked) {
      recorder.thresholdLocked = true;
      debugLog("[Setu mic] ambient lock", { threshold: recorder.speechThreshold.toFixed(4) });
    }

    recorder.onFrame?.({ rms, threshold: recorder.speechThreshold });

    const loud = rms >= recorder.speechThreshold;
    if (loud) {
      recorder.speechRunFrames += 1;
      if (recorder.speechRunFrames >= SPEECH_FRAMES_TO_CONFIRM) {
        recorder.heardSpeech = true;
        recorder.speechFrames += 1;
        recorder.silentSince = null;
        callbacks.onAutoStopProgress?.(0);
      }
    } else {
      recorder.speechRunFrames = 0;
      if (recorder.heardSpeech) {
        if (recorder.silentSince == null) recorder.silentSince = now;
        const silentFor = now - recorder.silentSince;
        callbacks.onAutoStopProgress?.(Math.min(1, silentFor / SILENCE_MS));
        if (silentFor >= SILENCE_MS && elapsed >= MIN_RECORDING_MS) {
          callbacks.onFinish(false);
          return;
        }
      } else if (elapsed >= NO_SPEECH_MS) {
        callbacks.onFinish(true);
        return;
      }
    }

    if (elapsed >= MAX_RECORDING_MS) {
      callbacks.onFinish(false);
    }
  };

  recorder.watchdog = window.setInterval(() => {
    const age = performance.now() - recorder.startedAt;
    if (recorder.framesSeen > 2) {
      window.clearInterval(recorder.watchdog);
      recorder.watchdog = 0;
      return;
    }
    if (age > 1500) {
      window.clearInterval(recorder.watchdog);
      recorder.watchdog = 0;
      callbacks.onWatchdog?.(
        "Mic paused by the phone — tap the orb to continue",
      );
      callbacks.onFinish(true);
    }
  }, 250);

  // mic_open is logged by the voice-loop gate with turn_id (avoids duplicate bursts).
  voiceClientLog("mic_stream_ready", { sampleRate: recorder.sampleRate });
  return recorder;
}

export function teardownRecorder(recorder: RecorderSession | null) {
  if (!recorder) return;
  window.clearInterval(recorder.watchdog);
  cancelAnimationFrame(recorder.raf);
  try {
    recorder.worklet.port.onmessage = null;
    recorder.worklet.disconnect();
  } catch {
    /* ignore */
  }
  try {
    recorder.silenceGain.disconnect();
    recorder.source.disconnect();
  } catch {
    /* ignore */
  }
  recorder.stream.getTracks().forEach((track) => track.stop());
}

export function recorderToWav(recorder: RecorderSession): Blob {
  return encodeWav(recorder.chunks, recorder.sampleRate);
}

export function speechMs(recorder: RecorderSession): number {
  return recorder.speechFrames * recorder.frameMs;
}
