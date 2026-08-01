import { debugLog, voiceClientLog } from "@/lib/debug";
import { ensureMicSession, releaseMicSession } from "@/lib/audio/mic-session";
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
/** Post-TTS delay before re-arming VAD (speakerphone echo). */
export const POST_TTS_RESUME_MS = 400;
/** Early teardown without speech — bug guard window. */
export const EARLY_TEARDOWN_MS = 2000;

export type RecorderSession = {
  context: AudioContext;
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  worklet: AudioWorkletNode;
  silenceGain: GainNode;
  chunks: Float32Array[];
  sampleRate: number;
  /** Armed only when VAD is live (mic_stream_ready) — never at getUserMedia request. */
  startedAt: number;
  turnId: number;
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
  maxTimer: number;
  constraintsPath: string;
  acquireMs: number;
  reusedStream: boolean;
  finished: boolean;
  onFrame?: (info: { rms: number; threshold: number }) => void;
};

export type RecorderCallbacks = {
  onLevel?: (amplitude: number, bands: { bass: number; treble: number }, micLevel: number, threshold: number) => void;
  onAutoStopProgress?: (progress: number) => void;
  onFinish: (cancelled: boolean, meta?: { reason?: string }) => void;
  onWatchdog?: (message: string) => void;
};

export type StopTurnResult = {
  /** Tracks stopped (0 when stream kept alive for next turn). */
  trackCount: number;
  early: boolean;
  ageMs: number;
  turnId: number;
  reason: string;
};

let workletReadyFor: AudioContext | null = null;

async function ensureWorklet(context: AudioContext) {
  if (workletReadyFor === context) return;
  await ensureVadWorklet(context);
  workletReadyFor = context;
}

function finishOnce(
  recorder: RecorderSession,
  callbacks: RecorderCallbacks,
  cancelled: boolean,
  reason: string,
) {
  if (recorder.finished) return;
  recorder.finished = true;
  if (reason === "no_speech" || reason === "max_recording") {
    console.info(`[audio] utterance_timeout turn_id=${recorder.turnId} reason=${reason}`);
    voiceClientLog("utterance_timeout", { turn_id: recorder.turnId, reason });
  }
  callbacks.onFinish(cancelled, { reason });
}

/**
 * Start a listen turn on the persistent mic session.
 * Timers (silence / no-speech / max / watchdog) arm only after the graph is live.
 */
export async function startVoiceRecorder(
  callbacks: RecorderCallbacks,
  options?: { turnId?: number },
): Promise<RecorderSession> {
  const turnId = options?.turnId ?? 0;
  const { stream, context, acquireMs, reused, constraintsPath } = await ensureMicSession();
  await ensureWorklet(context);

  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 256;
  const worklet = new AudioWorkletNode(context, getVadProcessorName());
  const silenceGain = context.createGain();
  silenceGain.gain.value = 0;
  source.connect(analyser);
  source.connect(worklet);
  worklet.connect(silenceGain);
  silenceGain.connect(context.destination);

  // Arm utterance window ONLY now — after stream/graph are ready.
  const startedAt = performance.now();

  const recorder: RecorderSession = {
    context,
    stream,
    source,
    analyser,
    worklet,
    silenceGain,
    chunks: [],
    sampleRate: context.sampleRate,
    startedAt,
    turnId,
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
    maxTimer: 0,
    constraintsPath,
    acquireMs,
    reusedStream: reused,
    finished: false,
  };

  console.info(`[audio] utterance_window_start turn_id=${turnId}`);
  voiceClientLog("utterance_window_start", { turn_id: turnId });
  voiceClientLog("mic_stream_ready", {
    sampleRate: recorder.sampleRate,
    constraints: recorder.constraintsPath,
    mic_acquire_ms: acquireMs,
    reused,
    turn_id: turnId,
  });
  console.info(`[audio] mic_acquire_ms=${acquireMs} turn_id=${turnId}`);

  const meterData = new Uint8Array(analyser.frequencyBinCount);
  const tickMeter = () => {
    if (recorder.finished) return;
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
    if (recorder.finished) return;
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
          finishOnce(recorder, callbacks, false, "silence_end");
          return;
        }
      } else if (elapsed >= NO_SPEECH_MS) {
        finishOnce(recorder, callbacks, true, "no_speech");
        return;
      }
    }

    if (elapsed >= MAX_RECORDING_MS) {
      finishOnce(recorder, callbacks, false, "max_recording");
    }
  };

  // Watchdog starts at mic_stream_ready (startedAt), not at getUserMedia request.
  recorder.watchdog = window.setInterval(() => {
    if (recorder.finished) {
      window.clearInterval(recorder.watchdog);
      recorder.watchdog = 0;
      return;
    }
    const age = performance.now() - recorder.startedAt;
    if (recorder.framesSeen > 2) {
      window.clearInterval(recorder.watchdog);
      recorder.watchdog = 0;
      return;
    }
    if (age > 1500) {
      window.clearInterval(recorder.watchdog);
      recorder.watchdog = 0;
      callbacks.onWatchdog?.("Mic paused by the phone — tap the orb to continue");
      finishOnce(recorder, callbacks, true, "watchdog");
    }
  }, 250);

  // Hard max also armed at stream ready (not at request).
  recorder.maxTimer = window.setTimeout(() => {
    if (!recorder.finished) finishOnce(recorder, callbacks, false, "max_recording");
  }, MAX_RECORDING_MS + 500);

  return recorder;
}

/**
 * End a listen turn: disconnect VAD nodes, clear timers.
 * Keeps MediaStream + AudioContext alive unless releaseStream=true.
 */
export function stopRecorderTurn(
  recorder: RecorderSession | null,
  options?: { reason?: string; releaseStream?: boolean },
): StopTurnResult {
  if (!recorder) {
    return { trackCount: 0, early: false, ageMs: 0, turnId: 0, reason: options?.reason || "none" };
  }
  recorder.finished = true;
  window.clearInterval(recorder.watchdog);
  recorder.watchdog = 0;
  window.clearTimeout(recorder.maxTimer);
  recorder.maxTimer = 0;
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
    recorder.analyser.disconnect();
  } catch {
    /* ignore */
  }

  const ageMs = Math.round(performance.now() - recorder.startedAt);
  const reason = options?.reason || "turn_end";
  const early = ageMs < EARLY_TEARDOWN_MS && !recorder.heardSpeech;
  if (early) {
    console.info(`[audio] teardown_early turn_id=${recorder.turnId} reason=${reason} age_ms=${ageMs}`);
    voiceClientLog("teardown_early", {
      turn_id: recorder.turnId,
      reason,
      age_ms: ageMs,
    });
  }

  let trackCount = 0;
  if (options?.releaseStream) {
    releaseMicSession();
    trackCount = 1;
  } else {
    // Stream kept — do not stop tracks between turns.
    voiceClientLog("mic_turn_stopped", {
      turn_id: recorder.turnId,
      keep_stream: true,
      reason,
      age_ms: ageMs,
    });
  }

  return { trackCount, early, ageMs, turnId: recorder.turnId, reason };
}

/** @deprecated use stopRecorderTurn — kept for call-site migration */
export function teardownRecorder(recorder: RecorderSession | null): number {
  return stopRecorderTurn(recorder, { reason: "teardown", releaseStream: false }).trackCount;
}

export function recorderToWav(recorder: RecorderSession): Blob {
  return encodeWav(recorder.chunks, recorder.sampleRate);
}

export function speechMs(recorder: RecorderSession): number {
  return recorder.speechFrames * recorder.frameMs;
}

export { releaseMicSession };
