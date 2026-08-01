/** Platform audio-session lifecycle — feature-detect navigator.audioSession. */

export type AudioSessionType = "playback" | "play-and-record" | "auto";

export const IOS_TTS_SETTLE_MS = 150;

type AudioSessionLike = { type?: string };
type SessionLog = (event: string, data: Record<string, unknown>) => void;

let sessionLog: SessionLog = () => undefined;

/** Optional hook for voiceClientLog — keeps this module free of path-alias imports. */
export function setAudioSessionLogger(fn: SessionLog): void {
  sessionLog = fn;
}

function getAudioSession(): AudioSessionLike | null {
  if (typeof navigator === "undefined") return null;
  try {
    return ((navigator as unknown as { audioSession?: AudioSessionLike }).audioSession ??
      null) as AudioSessionLike | null;
  } catch {
    return null;
  }
}

/** Feature-detect iPhone/iPad (incl. iPadOS desktop UA). */
export function isIosPlatform(userAgent = typeof navigator !== "undefined" ? navigator.userAgent : ""): boolean {
  if (/iPad|iPhone|iPod/i.test(userAgent)) return true;
  if (typeof navigator !== "undefined") {
    const nav = navigator as Navigator & { platform?: string; maxTouchPoints?: number };
    if (nav.platform === "MacIntel" && (nav.maxTouchPoints ?? 0) > 1) return true;
  }
  return false;
}

/**
 * Set navigator.audioSession.type when supported.
 * Never throws — Android/desktop without the API are no-ops.
 */
export function setAudioSession(type: AudioSessionType): boolean {
  try {
    const session = getAudioSession();
    if (!session) {
      console.info(`[audio] audio_session requested=${type} applied=false reason=unsupported`);
      sessionLog("audio_session", { requested: type, applied: false, reason: "unsupported" });
      return false;
    }
    session.type = type;
    console.info(`[audio] audio_session requested=${type} applied=true reason=ok`);
    sessionLog("audio_session", { requested: type, applied: true, reason: "ok" });
    return true;
  } catch {
    console.info(`[audio] audio_session requested=${type} applied=false reason=error`);
    sessionLog("audio_session", { requested: type, applied: false, reason: "error" });
    return false;
  }
}

/**
 * Shared-context route keeps play-and-record for the whole voice session.
 * No per-turn flip / settle delay (that caused 1.8s getUserMedia stalls).
 */
export async function prepareAssistantPlayback(options?: {
  afterTeardown?: () => void | Promise<void>;
  platformIsIos?: boolean;
}): Promise<{ settleMs: number }> {
  if (options?.afterTeardown) await options.afterTeardown();
  // Sticky: do not switch to "playback" between turns.
  sessionLog("audio_session", {
    requested: "play-and-record",
    applied: true,
    reason: "sticky_shared_context",
  });
  return { settleMs: 0 };
}

/** @deprecated settle delay removed for sticky play-and-record route */
export async function settleBeforeTtsPlayback(
  _platformIsIos: boolean = isIosPlatform(),
): Promise<number> {
  return 0;
}

/** Guard: mic must not open while thinking/speaking or TTS is active. */
export function micOpenBlockReason(opts: {
  voiceState: string;
  ttsActive: boolean;
}): "thinking" | "speaking" | "tts_active" | null {
  if (opts.ttsActive) return "tts_active";
  if (opts.voiceState === "thinking") return "thinking";
  if (opts.voiceState === "speaking") return "speaking";
  return null;
}
