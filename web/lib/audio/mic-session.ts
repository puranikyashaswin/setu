/**
 * Persistent mic session — one getUserMedia + AudioContext per voice session.
 * Turns only attach/detach VAD; tracks stay live so turn 2+ mic_acquire_ms stays low.
 */

export const AUDIO_ROUTE_MODE = "shared_context_play_and_record" as const;

type AudioSessionSetter = (type: "playback" | "play-and-record" | "auto") => boolean;

export const PREFERRED_MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 1,
  },
};

type SessionLog = (event: string, data: Record<string, unknown>) => void;

let sessionLog: SessionLog = () => undefined;
let setSession: AudioSessionSetter = () => false;
let sharedStream: MediaStream | null = null;
let sharedContext: AudioContext | null = null;
let sessionArmed = false;
let getUserMediaCalls = 0;
let routeModeLogged = false;
let constraintsPath: "processing_off" | "audio_true_fallback" = "processing_off";

export function setMicSessionLogger(fn: SessionLog): void {
  sessionLog = fn;
}

/** Wire setAudioSession from audio-session.ts (avoids path-alias imports here). */
export function setMicSessionAudioSession(fn: AudioSessionSetter): void {
  setSession = fn;
}

export function getSharedAudioContext(): AudioContext | null {
  return sharedContext;
}

export function getSharedMicStream(): MediaStream | null {
  return sharedStream;
}

export function getGetUserMediaCallCount(): number {
  return getUserMediaCalls;
}

export function getMicConstraintsPath(): string {
  return constraintsPath;
}

function audioContextConstructor(): typeof AudioContext {
  const root = globalThis as typeof globalThis & {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  const ctor = root.AudioContext || root.webkitAudioContext;
  if (!ctor) throw new Error("Web Audio is not supported in this browser");
  return ctor;
}

function streamAlive(stream: MediaStream | null): boolean {
  if (!stream) return false;
  const tracks = stream.getTracks();
  return tracks.length > 0 && tracks.every((t) => t.readyState === "live");
}

function logRouteModeOnce(): void {
  if (routeModeLogged) return;
  routeModeLogged = true;
  console.info(`[audio] audio_route_mode=${AUDIO_ROUTE_MODE}`);
  sessionLog("audio_route_mode", { mode: AUDIO_ROUTE_MODE });
}

/**
 * Arm play-and-record once and acquire mic stream + shared AudioContext.
 * Subsequent calls reuse the live stream (no getUserMedia, no session flip).
 */
export async function ensureMicSession(): Promise<{
  stream: MediaStream;
  context: AudioContext;
  acquireMs: number;
  reused: boolean;
  constraintsPath: string;
}> {
  const t0 = performance.now();

  if (streamAlive(sharedStream) && sharedContext && sharedContext.state !== "closed") {
    try {
      if (sharedContext.state !== "running") await sharedContext.resume();
    } catch {
      /* ignore */
    }
    const acquireMs = Math.round(performance.now() - t0);
    sessionLog("mic_acquire", { mic_acquire_ms: acquireMs, reused: true });
    console.info(`[audio] mic_acquire_ms=${acquireMs} reused=true`);
    return {
      stream: sharedStream!,
      context: sharedContext,
      acquireMs,
      reused: true,
      constraintsPath,
    };
  }

  // Fresh acquire — set session ONCE for the whole voice session.
  if (!sessionArmed) {
    setSession("play-and-record");
    sessionArmed = true;
    logRouteModeOnce();
  }

  const AudioContextConstructor = audioContextConstructor();
  if (!sharedContext || sharedContext.state === "closed") {
    sharedContext = new AudioContextConstructor();
  }
  try {
    await sharedContext.resume();
  } catch {
    /* ignore */
  }

  let stream: MediaStream;
  try {
    getUserMediaCalls += 1;
    stream = await navigator.mediaDevices.getUserMedia(PREFERRED_MIC_CONSTRAINTS);
    constraintsPath = "processing_off";
  } catch {
    getUserMediaCalls += 1;
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    constraintsPath = "audio_true_fallback";
  }
  sharedStream = stream;
  sessionLog("mic_constraints", { path: constraintsPath });
  console.info(`[audio] mic_constraints path=${constraintsPath}`);

  const acquireMs = Math.round(performance.now() - t0);
  sessionLog("mic_acquire", { mic_acquire_ms: acquireMs, reused: false });
  console.info(`[audio] mic_acquire_ms=${acquireMs} reused=false`);
  return {
    stream,
    context: sharedContext,
    acquireMs,
    reused: false,
    constraintsPath,
  };
}

/** End voice session: stop tracks, close context, reset audioSession to auto. */
export function releaseMicSession(): void {
  const stream = sharedStream;
  sharedStream = null;
  let trackCount = 0;
  if (stream) {
    try {
      const tracks = stream.getTracks();
      trackCount = tracks.length;
      tracks.forEach((t) => t.stop());
    } catch {
      /* ignore */
    }
  }
  console.info(`[audio] mic_tracks_stopped count=${trackCount} reason=session_end`);
  sessionLog("mic_tracks_stopped", { count: trackCount, reason: "session_end" });

  const context = sharedContext;
  sharedContext = null;
  if (context && context.state !== "closed") {
    void context.close().then(() => {
      console.info("[audio] recorder_context_closed");
      sessionLog("recorder_context_closed", { reason: "session_end" });
    }).catch(() => {
      sessionLog("recorder_context_closed", { already_closed: true });
    });
  }

  if (sessionArmed) {
    setSession("auto");
    sessionArmed = false;
  }
}

/** Test helper */
export function __resetMicSessionForTests(): void {
  sharedStream = null;
  sharedContext = null;
  sessionArmed = false;
  getUserMediaCalls = 0;
  routeModeLogged = false;
  constraintsPath = "processing_off";
  setSession = () => false;
}
