/**
 * Single persistent HTMLAudioElement for all TTS turns.
 * iOS Safari only allows programmatic play() on elements blessed by a user gesture
 * that remain alive — never create new Audio() per turn.
 */

type SharedAudioLog = (event: string, data?: Record<string, unknown>) => void;

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
    audio.load();
  } catch {
    /* ignore */
  }
  void audio
    .play()
    .then(() => {
      audio.pause();
      audio.currentTime = 0;
      audio.removeAttribute("src");
      try {
        audio.load();
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

export function pauseSharedAudioElement(): void {
  if (!sharedAudio) return;
  try {
    sharedAudio.onended = null;
    sharedAudio.onerror = null;
    sharedAudio.pause();
    sharedAudio.removeAttribute("src");
    sharedAudio.load();
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
  pauseSharedAudioElement();
  sharedAudio = null;
  unlocked = false;
}
