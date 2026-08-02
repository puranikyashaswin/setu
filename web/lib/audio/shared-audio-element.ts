/**
 * Single persistent HTMLAudioElement for all TTS turns.
 * iOS Safari only allows programmatic play() on elements blessed by a user gesture
 * that remain alive — never create new Audio() per turn.
 *
 * Critical: do NOT call audio.load() after clearing src — that resets Safari's
 * media engagement and makes later TTS play() fail with NotAllowedError.
 */

type SharedAudioLog = (event: string, data?: Record<string, unknown>) => void;

/** Tiny silent WAV — used only to unlock the element inside a user gesture. */
const SILENT_WAV =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=";

let sessionLog: SharedAudioLog = () => undefined;
let sharedAudio: HTMLAudioElement | null = null;
let unlocked = false;

export function setSharedAudioLogger(fn: SharedAudioLog): void {
  sessionLog = fn;
}

export function ensureSharedAudioElement(): HTMLAudioElement {
  if (!sharedAudio) {
    sharedAudio = new Audio();
    sharedAudio.preload = "auto";
    sharedAudio.volume = 1;
    // iOS: keep playback inline (never force fullscreen video-style audio).
    try {
      sharedAudio.setAttribute?.("playsinline", "true");
      sharedAudio.setAttribute?.("webkit-playsinline", "true");
      // @ts-expect-error playsInline exists on HTMLMediaElement in WebKit
      sharedAudio.playsInline = true;
    } catch {
      /* ignore */
    }
  }
  return sharedAudio;
}

export function isSharedAudioUnlocked(): boolean {
  return unlocked;
}

/** Call synchronously inside a user-gesture handler (tap). */
export function unlockSharedAudioElement(): void {
  if (unlocked) return;
  const audio = ensureSharedAudioElement();
  try {
    audio.src = SILENT_WAV;
  } catch {
    /* ignore */
  }
  void audio
    .play()
    .then(() => {
      audio.pause();
      audio.currentTime = 0;
      // Keep engagement: clear src without load() — load() revokes iOS unlock.
      try {
        audio.removeAttribute("src");
      } catch {
        /* ignore */
      }
      unlocked = true;
      console.info("[audio] shared_audio_unlocked=true");
      sessionLog("shared_audio_unlocked", { ok: true });
    })
    .catch(() => {
      /* Not in a gesture context yet — listener will retry on next tap. */
    });
}

/**
 * Stop current TTS without resetting Safari media engagement.
 * Never call load() here.
 */
export function pauseSharedAudioElement(): void {
  if (!sharedAudio) return;
  try {
    sharedAudio.onended = null;
    sharedAudio.onerror = null;
    sharedAudio.pause();
    try {
      sharedAudio.currentTime = 0;
    } catch {
      /* ignore */
    }
    sharedAudio.removeAttribute("src");
  } catch {
    /* ignore */
  }
}

export function getSharedAudioElement(): HTMLAudioElement | null {
  return sharedAudio;
}

/** Register once — unlock on first pointer/touch anywhere on the page. */
export function installSharedAudioUnlockListener(root: Document | HTMLElement = document): () => void {
  const unlock = () => unlockSharedAudioElement();
  root.addEventListener("pointerdown", unlock, { capture: true });
  root.addEventListener("touchstart", unlock, { capture: true });
  return () => {
    root.removeEventListener("pointerdown", unlock, { capture: true });
    root.removeEventListener("touchstart", unlock, { capture: true });
  };
}

/** Test helper */
export function __resetSharedAudioForTests(): void {
  if (sharedAudio) {
    try {
      sharedAudio.pause();
      sharedAudio.removeAttribute("src");
    } catch {
      /* ignore */
    }
  }
  sharedAudio = null;
  unlocked = false;
}
