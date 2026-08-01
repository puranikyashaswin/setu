/**
 * Persistent mic session — one getUserMedia + AudioContext per voice session.
 * Turns only attach/detach VAD; tracks stay live so turn 2+ mic_acquire_ms stays low.
 *
 * opening_in_flight guard lifecycle:
 *   SET   — only when a real getUserMedia is about to start (beginGumOpen)
 *   CLEAR — finally after GUM resolve/reject/timeout (endGumOpen)
 *   STUCK — if still set > OPENING_STUCK_MS, log mic_open_stuck, clear, allow one retry
 * Attach-only paths (live stream reuse) never set the guard.
 */

/** Mic is analysis-only; TTS is always HTMLAudioElement (decoupled). */
export const AUDIO_ROUTE_MODE = "html_audio_persistent_mic" as const;
export const OPENING_STUCK_MS = 3000;
export const LISTENING_DEAD_MIC_MS = 4000;
export const GUM_OPEN_TIMEOUT_MS = 8000;

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

export type MicStreamState = {
  exists: boolean;
  live_tracks: number;
  track_states: string[];
  inactive: boolean;
};

let sessionLog: SessionLog = () => undefined;
let setSession: AudioSessionSetter = () => false;
let sharedStream: MediaStream | null = null;
let sharedContext: AudioContext | null = null;
let sessionArmed = false;
let getUserMediaCalls = 0;
let routeModeLogged = false;
let constraintsPath: "processing_off" | "audio_true_fallback" = "processing_off";

/** True only while a real getUserMedia promise is pending. */
let openingInFlight = false;
let openingStartedAt = 0;
let stuckRetryUsed = false;
let stuckTimer: ReturnType<typeof setTimeout> | null = null;
let onStuckRetry: (() => void) | null = null;

function clearStuckTimer(): void {
  if (stuckTimer != null) {
    clearTimeout(stuckTimer);
    stuckTimer = null;
  }
}

function armStuckTimer(): void {
  clearStuckTimer();
  stuckTimer = setTimeout(() => {
    stuckTimer = null;
    if (!openingInFlight) return;
    const age = Math.round(performance.now() - openingStartedAt);
    console.info(`[audio] mic_open_stuck age_ms=${age} — clearing guard for one retry`);
    sessionLog("mic_open_stuck", { age_ms: age, action: "clear_and_retry" });
    openingInFlight = false;
    if (!stuckRetryUsed) {
      stuckRetryUsed = true;
      const retry = onStuckRetry;
      if (retry) {
        try {
          retry();
        } catch {
          /* ignore */
        }
      }
    }
  }, OPENING_STUCK_MS);
}

/** Optional: page registers a single retry when stuck timer clears the guard. */
export function setMicOpenStuckRetry(fn: (() => void) | null): void {
  onStuckRetry = fn;
}

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

export function isOpeningInFlight(): boolean {
  return openingInFlight;
}

export function getMicStreamState(stream: MediaStream | null = sharedStream): MicStreamState {
  if (!stream) {
    return { exists: false, live_tracks: 0, track_states: [], inactive: true };
  }
  const tracks = stream.getTracks();
  const track_states = tracks.map((t) => t.readyState);
  const live_tracks = tracks.filter((t) => t.readyState === "live").length;
  const sessionInactive = typeof stream.active === "boolean" ? !stream.active : false;
  const inactive = live_tracks === 0 || sessionInactive;
  return { exists: true, live_tracks, track_states, inactive };
}

export function logMicSessionStreamState(reason: string): MicStreamState {
  const state = getMicStreamState();
  console.info(
    `[audio] mic_session_stream_state exists=${state.exists} live_tracks=${state.live_tracks} inactive=${state.inactive} reason=${reason}`,
  );
  sessionLog("mic_session_stream_state", { ...state, reason });
  return state;
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

export function streamAlive(stream: MediaStream | null): boolean {
  if (!stream) return false;
  const state = getMicStreamState(stream);
  return state.live_tracks > 0 && !state.inactive;
}

function logRouteModeOnce(): void {
  if (routeModeLogged) return;
  routeModeLogged = true;
  console.info(`[audio] audio_route_mode=${AUDIO_ROUTE_MODE}`);
  sessionLog("audio_route_mode", { mode: AUDIO_ROUTE_MODE });
}

/**
 * Claim the GUM open slot. Attach-only callers must not use this.
 * Clears stuck flags older than OPENING_STUCK_MS (one retry).
 */
export function beginGumOpen(): { ok: true; stuckCleared: boolean } | { ok: false; reason: "opening_in_flight" } {
  const now = performance.now();
  if (openingInFlight) {
    const age = now - openingStartedAt;
    if (age >= OPENING_STUCK_MS) {
      // Defensive: timer should have cleared already; allow claim if still stuck.
      stuckRetryUsed = true;
      console.info(`[audio] mic_open_stuck age_ms=${Math.round(age)} — clearing guard for one retry`);
      sessionLog("mic_open_stuck", { age_ms: Math.round(age), action: "clear_and_retry" });
      openingInFlight = false;
      clearStuckTimer();
    } else {
      sessionLog("mic_open_blocked", { reason: "opening_in_flight", age_ms: Math.round(age) });
      return { ok: false, reason: "opening_in_flight" };
    }
  }
  const stuckCleared = stuckRetryUsed;
  openingInFlight = true;
  openingStartedAt = now;
  armStuckTimer();
  return { ok: true, stuckCleared };
}

/** Always clear in finally after GUM attempt (success, failure, or timeout). */
export function endGumOpen(): void {
  openingInFlight = false;
  clearStuckTimer();
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function acquireGetUserMedia(): Promise<{
  stream: MediaStream;
  path: "processing_off" | "audio_true_fallback";
}> {
  try {
    getUserMediaCalls += 1;
    const stream = await navigator.mediaDevices.getUserMedia(PREFERRED_MIC_CONSTRAINTS);
    return { stream, path: "processing_off" };
  } catch {
    getUserMediaCalls += 1;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    return { stream, path: "audio_true_fallback" };
  }
}

/**
 * Arm play-and-record and ensure a live mic stream + AudioContext.
 * Live reuse: attach path — no opening_in_flight.
 * Dead/missing stream: GUM path — guard set/cleared in finally, hard timeout.
 */
export async function ensureMicSession(options?: {
  turnId?: number;
}): Promise<{
  stream: MediaStream;
  context: AudioContext;
  acquireMs: number;
  reused: boolean;
  constraintsPath: string;
  path: "attach" | "gum";
}> {
  const t0 = performance.now();
  const turnId = options?.turnId;

  setSession("play-and-record");
  if (!sessionArmed) {
    sessionArmed = true;
    logRouteModeOnce();
  }

  logMicSessionStreamState(turnId != null ? `ensure_turn_${turnId}` : "ensure");

  if (sharedStream && !streamAlive(sharedStream)) {
    console.info("[audio] mic_stream_dead — re-acquiring");
    sessionLog("mic_stream_dead", { turn_id: turnId ?? null });
    try {
      sharedStream.getTracks().forEach((t) => t.stop());
    } catch {
      /* ignore */
    }
    sharedStream = null;
  }

  if (streamAlive(sharedStream) && sharedContext && sharedContext.state !== "closed") {
    try {
      if (sharedContext.state !== "running") await sharedContext.resume();
    } catch {
      /* ignore */
    }
    const acquireMs = Math.round(performance.now() - t0);
    sessionLog("mic_acquire", { mic_acquire_ms: acquireMs, reused: true, path: "attach", turn_id: turnId ?? null });
    sessionLog("mic_attach", { turn_id: turnId ?? null, mic_acquire_ms: acquireMs });
    console.info(`[audio] mic_attach turn_id=${turnId ?? "-"} mic_acquire_ms=${acquireMs}`);
    return {
      stream: sharedStream!,
      context: sharedContext,
      acquireMs,
      reused: true,
      constraintsPath,
      path: "attach",
    };
  }

  // Real getUserMedia — guard only for this path.
  const claim = beginGumOpen();
  if (!claim.ok) {
    throw new Error("opening_in_flight");
  }
  try {
    const AudioContextConstructor = audioContextConstructor();
    if (!sharedContext || sharedContext.state === "closed") {
      sharedContext = new AudioContextConstructor();
    }
    try {
      await sharedContext.resume();
    } catch {
      /* ignore */
    }

    const acquired = await withTimeout(acquireGetUserMedia(), GUM_OPEN_TIMEOUT_MS, "mic_open_timeout");
    sharedStream = acquired.stream;
    constraintsPath = acquired.path;
    sessionLog("mic_constraints", { path: constraintsPath });
    console.info(`[audio] mic_constraints path=${constraintsPath}`);

    const acquireMs = Math.round(performance.now() - t0);
    stuckRetryUsed = false;
    sessionLog("mic_acquire", {
      mic_acquire_ms: acquireMs,
      reused: false,
      path: "gum",
      turn_id: turnId ?? null,
    });
    console.info(`[audio] mic_acquire_ms=${acquireMs} reused=false path=gum`);
    return {
      stream: acquired.stream,
      context: sharedContext,
      acquireMs,
      reused: false,
      constraintsPath,
      path: "gum",
    };
  } finally {
    endGumOpen();
  }
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
    void context
      .close()
      .then(() => {
        console.info("[audio] recorder_context_closed");
        sessionLog("recorder_context_closed", { reason: "session_end" });
      })
      .catch(() => {
        sessionLog("recorder_context_closed", { already_closed: true });
      });
  }

  if (sessionArmed) {
    setSession("auto");
    sessionArmed = false;
  }
  openingInFlight = false;
  openingStartedAt = 0;
  stuckRetryUsed = false;
  clearStuckTimer();
  onStuckRetry = null;
}

/** Listening dead-mic watchdog helper (testable). */
export function createListeningDeadMicWatchdog(options: {
  turnId: number;
  hasUtteranceWindowStarted: () => boolean;
  onDead: () => void;
  ms?: number;
}): { clear: () => void } {
  const ms = options.ms ?? LISTENING_DEAD_MIC_MS;
  let cleared = false;
  const id = globalThis.setTimeout(() => {
    if (cleared) return;
    cleared = true;
    if (options.hasUtteranceWindowStarted()) return;
    console.info(`[audio] listening_dead_mic turn_id=${options.turnId}`);
    sessionLog("listening_dead_mic", { turn_id: options.turnId, ms });
    options.onDead();
  }, ms);
  return {
    clear: () => {
      if (cleared) return;
      cleared = true;
      globalThis.clearTimeout(id);
    },
  };
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
  openingInFlight = false;
  openingStartedAt = 0;
  stuckRetryUsed = false;
  clearStuckTimer();
  onStuckRetry = null;
}

/** Test helper — simulate a stuck open without awaiting GUM. */
export function __forceOpeningInFlightForTests(ageMs = 0): void {
  openingInFlight = true;
  openingStartedAt = performance.now() - ageMs;
  if (ageMs >= OPENING_STUCK_MS) {
    // Leave uncleared so beginGumOpen / stuck path can exercise clear.
    clearStuckTimer();
  } else {
    armStuckTimer();
  }
}
