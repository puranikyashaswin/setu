import { debugLog, voiceClientLog } from "@/lib/debug";
import { ensureMicSession, releaseMicSession } from "@/lib/audio/mic-session";
import { encodeWav } from "@/lib/audio/wav";
import { ensureVadWorklet, getVadProcessorName } from "@/lib/audio/worklet-vad";
import { VadLevelTelemetry } from "@/lib/audio/vad-levels";
import { trimUtteranceSilence } from "@/lib/audio/trim-silence";
import {
  VAD_THRESHOLD_FLOOR,
  computeSpeechThreshold,
} from "@/lib/audio/vad-threshold";
import { TurnEndpoint } from "@/lib/audio/endpoint";

export const SILENCE_MS = 900;
export const MIN_RECORDING_MS = 900;
export const MAX_RECORDING_MS = 15000;
export const NO_SPEECH_MS = 7000;
export const SPEECH_LEVEL = VAD_THRESHOLD_FLOOR;
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
  detached: boolean;
  ambientRms: number;
  rmsMax: number;
  /** Max RMS since speech started — drives peak-relative silence endpointing. */
  peakRms: number;
  controller: TurnEndpoint;
  lastEndpointStateLogAt: number;
  frameSeenLogged: boolean;
  vadTelemetry: VadLevelTelemetry;
  /** server_vad_v1: passive PCM tap for streaming (does not affect local capture). */
  onPcm?: (samples: Float32Array) => void;
  /** server_vad_v1: when true, local endpoint decisions are suppressed (server is authoritative). */
  localEndpointSuppressed: boolean;
  localEndpointSuppressedLogged: boolean;
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

/** Single-flight turn ownership: one active recorder/endpoint timer per turn_id. */
let activeMicTurnId: number | null = null;

/** Returns false (and logs mic_open_skipped) when the turn already owns a live recorder. */
export function claimMicTurn(turnId: number): boolean {
  if (activeMicTurnId === turnId) {
    console.info(`[audio] mic_open_skipped reason=turn_already_active turn_id=${turnId}`);
    console.info(`[audio] recorder_start_skipped turn_id=${turnId} reason=turn_already_active`);
    voiceClientLog("mic_open_skipped", { reason: "turn_already_active", turn_id: turnId });
    voiceClientLog("recorder_start_skipped", { turn_id: turnId, reason: "turn_already_active" });
    return false;
  }
  activeMicTurnId = turnId;
  return true;
}

export function releaseMicTurn(turnId: number): void {
  if (activeMicTurnId === turnId) activeMicTurnId = null;
}

/** Stale callbacks from an old turn check this before touching current state. */
export function isMicTurnCurrent(turnId: number): boolean {
  return activeMicTurnId === turnId;
}

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
  if (!claimMicTurn(turnId)) {
    throw new Error("turn_already_active");
  }
  let session: Awaited<ReturnType<typeof ensureMicSession>>;
  try {
    session = await ensureMicSession({ turnId });
    await ensureWorklet(session.context);
  } catch (error) {
    releaseMicTurn(turnId);
    throw error;
  }
  const { stream, context, acquireMs, reused, constraintsPath } = session;

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
    detached: false,
    ambientRms: VAD_THRESHOLD_FLOOR,
    rmsMax: 0,
    peakRms: 0,
    controller: null as unknown as TurnEndpoint,
    lastEndpointStateLogAt: 0,
    frameSeenLogged: false,
    localEndpointSuppressed: false,
    localEndpointSuppressedLogged: false,
    vadTelemetry: new VadLevelTelemetry(turnId),
  };
  recorder.controller = new TurnEndpoint(turnId, (reason) => {
    finishOnce(recorder, callbacks, false, reason);
  });
  recorder.controller.startedAtMs = startedAt;

  console.info(
    `[audio] endpoint_runtime_verified turn_id=${turnId} detector_created=true frame_hook=worklet callback_bound=true`,
  );
  voiceClientLog("endpoint_runtime_verified", {
    turn_id: turnId,
    detector_created: true,
    frame_hook: "worklet",
    callback_bound: true,
  });

  console.info(`[audio] recorder_lifecycle event=start turn_id=${turnId}`);
  console.info(`[audio] utterance_window_start turn_id=${turnId}`);
  voiceClientLog("recorder_lifecycle", { event: "start", turn_id: turnId });
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
      recorder.onPcm?.(data.samples);
    }

    const rms = data.rms ?? 0;
    recorder.rmsMax = Math.max(recorder.rmsMax, rms);
    recorder.vadTelemetry.onFrame(rms, recorder.speechThreshold, now);

    if (!recorder.thresholdLocked && elapsed < AMBIENT_MS) {
      recorder.ambientSum += rms;
      recorder.ambientCount += 1;
      if (recorder.ambientCount > 0) {
        const ambient = recorder.ambientSum / recorder.ambientCount;
        recorder.ambientRms = ambient;
        recorder.speechThreshold = computeSpeechThreshold(ambient);
      }
    } else if (!recorder.thresholdLocked) {
      recorder.thresholdLocked = true;
      if (recorder.ambientCount > 0) {
        recorder.ambientRms = recorder.ambientSum / recorder.ambientCount;
      }
      debugLog("[Setu mic] ambient lock", { threshold: recorder.speechThreshold.toFixed(4) });
    }

    recorder.onFrame?.({ rms, threshold: recorder.speechThreshold });

    if (!recorder.frameSeenLogged && elapsed <= 1000) {
      recorder.frameSeenLogged = true;
      console.info(
        `[audio] endpoint_frame_seen turn_id=${recorder.turnId} rms=${rms.toFixed(4)} detector_active=true`,
      );
      voiceClientLog("endpoint_frame_seen", {
        turn_id: recorder.turnId,
        rms: Number(rms.toFixed(4)),
        detector_active: true,
      });
    }

    // ONE authoritative endpoint owner — adaptive noise-floor onset + quiet end.
    // server_vad_v1: feeding stops once the server owns endpointing; the
    // max_recording timer (separately armed) remains the safety cap.
    if (!recorder.localEndpointSuppressed) {
      recorder.controller.handleAudioFrame(recorder.turnId, rms, now);
      if (recorder.finished) return; // finishTurnOnce fired inside handleAudioFrame
    } else if (!recorder.localEndpointSuppressedLogged) {
      recorder.localEndpointSuppressedLogged = true;
      voiceClientLog("vad_local_endpoint_suppressed", { turn_id: recorder.turnId });
    }

    // Sync legacy heardSpeech from adaptive onset inside TurnEndpoint.
    // Count EVERY post-confirm frame — speechMs() uses speechFrames, and a
    // single +1 made every real utterance look like ~3ms → silent noise_discard.
    if (recorder.controller.confirmedSpeech) {
      if (!recorder.heardSpeech) {
        recorder.heardSpeech = true;
        callbacks.onAutoStopProgress?.(0);
      }
      recorder.speechFrames += 1;
      recorder.silentSince = null;
    }

    if (now - recorder.lastEndpointStateLogAt >= 1000) {
      recorder.lastEndpointStateLogAt = now;
      const quietMs = Math.round(recorder.controller.quietMs(now));
      const gapMs = Math.round(recorder.controller.sinceLastMeaningfulSpeechMs(now));
      const onsetFloor = recorder.controller.onsetFloor;
      console.info(
        `[audio] vad_endpoint_state turn_id=${recorder.turnId} ambient_rms=${recorder.controller.ambientBaseline.toFixed(4)} smoothed_rms=${recorder.controller.smoothedRms.toFixed(4)} quiet_ceiling=${recorder.controller.quietCeiling.toFixed(4)} onset_floor=${onsetFloor.toFixed(4)} confirmed_speech=${recorder.controller.confirmedSpeech} onset_rejected=${recorder.controller.lastOnsetRejectedReason ?? "none"} quiet_ms=${quietMs} since_last_meaningful_speech_ms=${gapMs}`,
      );
      voiceClientLog("vad_endpoint_state", {
        turn_id: recorder.turnId,
        ambient_rms: Number(recorder.controller.ambientBaseline.toFixed(4)),
        vad_noise_floor: Number(recorder.controller.ambientBaseline.toFixed(4)),
        smoothed_rms: Number(recorder.controller.smoothedRms.toFixed(4)),
        quiet_ceiling: recorder.controller.quietCeiling,
        confirmed_speech: recorder.controller.confirmedSpeech,
        onset_snr: recorder.controller.lastOnsetSnr,
        onset_rejected_reason: recorder.controller.lastOnsetRejectedReason,
        quiet_ms: quietMs,
        since_last_meaningful_speech_ms: gapMs,
      });
    }

    if (recorder.heardSpeech || recorder.controller.confirmedSpeech) {
      recorder.peakRms = Math.max(recorder.peakRms, rms);
    }
    if (recorder.heardSpeech) {
      callbacks.onAutoStopProgress?.(recorder.controller.quietProgress(now));
    } else if (elapsed >= NO_SPEECH_MS) {
      // Adaptive TurnEndpoint owns speech confirmation — do NOT promote
      // near-ambient energy via legacy delta_weak (ghost turns / listen loops).
      voiceClientLog("utterance_timeout", {
        turn_id: recorder.turnId,
        reason: "no_speech",
        rms_max: Number(recorder.rmsMax.toFixed(4)),
        vad_noise_floor: Number(recorder.controller.ambientBaseline.toFixed(4)),
        onset_rejected_reason: recorder.controller.lastOnsetRejectedReason,
      });
      finishOnce(recorder, callbacks, true, "no_speech");
      return;
    }

    if (elapsed >= MAX_RECORDING_MS) {
      recorder.controller.finishTurnOnce(recorder.turnId, "max_recording", now);
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

  // Hard max also armed at stream ready (not at request). Safety fallback only.
  recorder.maxTimer = window.setTimeout(() => {
    recorder.controller.finishTurnOnce(recorder.turnId, "max_recording", performance.now());
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
  if (recorder.detached) {
    console.info(`[audio] recorder_lifecycle event=stale_ignored turn_id=${recorder.turnId}`);
    voiceClientLog("recorder_lifecycle", {
      event: "stale_ignored",
      turn_id: recorder.turnId,
      reason: options?.reason || "turn_end",
    });
    return { trackCount: 0, early: false, ageMs: 0, turnId: recorder.turnId, reason: options?.reason || "turn_end" };
  }
  recorder.detached = true;
  recorder.finished = true;
  recorder.controller.invalidate();
  releaseMicTurn(recorder.turnId);
  console.info(`[audio] recorder_lifecycle event=detach turn_id=${recorder.turnId}`);
  voiceClientLog("recorder_lifecycle", { event: "detach", turn_id: recorder.turnId });
  recorder.vadTelemetry.flush(recorder.speechThreshold);
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
  const trimmed = trimUtteranceSilence(recorder.chunks, recorder.sampleRate, {
    speechThreshold: recorder.speechThreshold,
  });
  return encodeWav(trimmed, recorder.sampleRate);
}

export function speechMs(recorder: RecorderSession): number {
  // Prefer authoritative confirm→now duration when available (frame counting
  // alone can under-count if the worklet quantum differs from frameMs).
  const confirmedAt = recorder.controller?.confirmedAtMs ?? 0;
  if (recorder.controller?.confirmedSpeech && confirmedAt > 0) {
    const last = recorder.controller.lastFrameAtMs ?? confirmedAt;
    return Math.max(0, last - confirmedAt);
  }
  return recorder.speechFrames * recorder.frameMs;
}

export { releaseMicSession };
