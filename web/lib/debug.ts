/** Debug logging + voice client event ring (phone session capture). */

export type VoiceClientEvent = {
  t: number;
  event: string;
  [key: string]: unknown;
};

const RING_MAX = 100;
const STORAGE_KEY = "setu_debug_log";

let ring: VoiceClientEvent[] = [];
let helpersInstalled = false;
let dumpButtonInstalled = false;

function loadRingFromStorage() {
  if (typeof window === "undefined") return;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as VoiceClientEvent[];
    if (Array.isArray(parsed)) ring = parsed.slice(-RING_MAX);
  } catch {
    /* ignore corrupt storage */
  }
}

function persistRing() {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(ring));
  } catch {
    /* quota / private mode */
  }
}

export function isDebugAudio(): boolean {
  if (typeof window === "undefined") return false;
  if (process.env.NODE_ENV === "development") {
    const params = new URLSearchParams(window.location.search);
    if (params.get("debug") === "0") return false;
    return true;
  }
  const params = new URLSearchParams(window.location.search);
  return params.get("debug") === "1";
}

export function debugLog(...args: unknown[]) {
  if (isDebugAudio()) console.info(...args);
}

/** Always records; prints when debug mode is on. */
export function voiceClientLog(event: string, data?: Record<string, unknown>) {
  if (typeof window !== "undefined" && ring.length === 0) loadRingFromStorage();
  const entry: VoiceClientEvent = { t: Date.now(), event, ...(data || {}) };
  ring.push(entry);
  if (ring.length > RING_MAX) ring = ring.slice(-RING_MAX);
  persistRing();
  debugLog(`[voice] event=${event}`, data ?? "");
}

export function getSetuDebugLog(): VoiceClientEvent[] {
  if (typeof window !== "undefined" && ring.length === 0) loadRingFromStorage();
  return ring.slice();
}

export async function copySetuDebugLog(): Promise<boolean> {
  const json = JSON.stringify(getSetuDebugLog(), null, 2);
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(json);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = json;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** Share sheet fallback when clipboard is blocked (common on iOS). */
export async function shareSetuDebugLog(): Promise<boolean> {
  const json = JSON.stringify(getSetuDebugLog(), null, 2);
  const nav = navigator as Navigator & {
    share?: (data: { title?: string; text?: string }) => Promise<void>;
  };
  if (!nav.share) return copySetuDebugLog();
  try {
    await nav.share({ title: "Setu debug log", text: json });
    return true;
  } catch {
    return copySetuDebugLog();
  }
}

function ensureDumpButton() {
  if (typeof document === "undefined" || dumpButtonInstalled) return;
  if (!isDebugAudio()) return;
  dumpButtonInstalled = true;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "Copy debug log";
  btn.setAttribute("aria-label", "Copy Setu debug log");
  btn.style.cssText = [
    "position:fixed",
    "right:12px",
    "bottom:12px",
    "z-index:2147483647",
    "padding:10px 12px",
    "border:0",
    "border-radius:10px",
    "background:#111",
    "color:#fff",
    "font:600 12px/1.2 system-ui,sans-serif",
    "opacity:0.85",
    "touch-action:manipulation",
  ].join(";");
  btn.addEventListener("click", () => {
    void (async () => {
      const ok = (await shareSetuDebugLog()) || (await copySetuDebugLog());
      btn.textContent = ok ? "Copied ✓" : "Copy failed";
      window.setTimeout(() => {
        btn.textContent = "Copy debug log";
      }, 1600);
    })();
  });
  const mount = () => document.body?.appendChild(btn);
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });
}

/** Expose console helpers + optional on-screen dump when ?debug=1. */
export function installDebugHelpers() {
  if (typeof window === "undefined" || helpersInstalled) return;
  helpersInstalled = true;
  loadRingFromStorage();
  const w = window as Window & {
    copySetuDebugLog?: typeof copySetuDebugLog;
    getSetuDebugLog?: typeof getSetuDebugLog;
    shareSetuDebugLog?: typeof shareSetuDebugLog;
  };
  w.copySetuDebugLog = copySetuDebugLog;
  w.getSetuDebugLog = getSetuDebugLog;
  w.shareSetuDebugLog = shareSetuDebugLog;
  ensureDumpButton();
}

if (typeof window !== "undefined") {
  installDebugHelpers();
}
