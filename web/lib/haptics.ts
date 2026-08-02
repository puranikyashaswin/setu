/**
 * Light feedback for Voice Health. Vibration API works on Android;
 * iPhone Safari has no vibrate — we fall back to a short Web Audio tick
 * (must run inside a user-gesture chain after Run / autorun tap).
 */

export type HapticKind = "tap" | "step" | "pass" | "warn" | "fail";

export const HAPTIC_PATTERNS: Record<HapticKind, number[]> = {
  tap: [12],
  step: [10],
  pass: [18, 45, 18, 45, 55],
  warn: [28, 55, 28],
  fail: [55, 40, 55, 40, 90],
};

export function canVibrate(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.vibrate === "function";
}

/** Returns true if the browser accepted the vibrate call. */
export function vibratePattern(pattern: number | number[]): boolean {
  if (!canVibrate()) return false;
  try {
    return Boolean(navigator.vibrate(pattern));
  } catch {
    return false;
  }
}

let clickCtx: AudioContext | null = null;

function audioContextConstructor(): (typeof AudioContext) | null {
  if (typeof window === "undefined") return null;
  return (
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ||
    null
  );
}

/** Soft tick for iOS (no Vibration API). Safe no-op if AudioContext blocked. */
export async function playHapticClick(kind: HapticKind = "tap"): Promise<boolean> {
  const Ctor = audioContextConstructor();
  if (!Ctor) return false;
  try {
    if (!clickCtx || clickCtx.state === "closed") {
      clickCtx = new Ctor();
    }
    if (clickCtx.state === "suspended") {
      await clickCtx.resume();
    }
    const now = clickCtx.currentTime;
    const osc = clickCtx.createOscillator();
    const gain = clickCtx.createGain();
    const freq = kind === "fail" ? 140 : kind === "warn" ? 220 : kind === "pass" ? 520 : 380;
    const dur = kind === "pass" ? 0.07 : kind === "fail" ? 0.09 : 0.045;
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.045, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    osc.connect(gain);
    gain.connect(clickCtx.destination);
    osc.start(now);
    osc.stop(now + dur + 0.01);
    return true;
  } catch {
    return false;
  }
}

/**
 * Prefer native vibrate; always attempt a soft click so iPhone still "feels" feedback
 * after the user-gesture that started the check.
 */
export async function haptic(kind: HapticKind): Promise<void> {
  vibratePattern(HAPTIC_PATTERNS[kind]);
  if (!canVibrate() || kind === "pass" || kind === "fail" || kind === "warn") {
    await playHapticClick(kind);
  }
}

export function hapticForOverall(status: "pass" | "warn" | "fail" | "skip" | string): Promise<void> {
  if (status === "pass") return haptic("pass");
  if (status === "warn") return haptic("warn");
  if (status === "fail") return haptic("fail");
  return haptic("tap");
}
