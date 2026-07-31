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
