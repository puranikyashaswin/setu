/**
 * Voice Health — scoreable checks for testing Setu anywhere (phone or desktop).
 * Pure scoring lives here; the /voice-check page runs the live probes.
 */

export type CheckStatus = "pass" | "warn" | "fail" | "skip";

export type HealthCheckResult = {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  ms?: number;
};

export type HealthReport = {
  overall: CheckStatus;
  checks: HealthCheckResult[];
  tips: string[];
  at: number;
};

/** Close-talk VAD expects near-mic speech; room tone alone should not pass mic liveliness. */
export const MIC_LIVE_RMS_MIN = 0.01;
export const MIC_CLOSE_TALK_RMS_HINT = 0.022;

export function scoreOverall(checks: HealthCheckResult[]): CheckStatus {
  if (checks.some((c) => c.status === "fail")) return "fail";
  if (checks.some((c) => c.status === "warn")) return "warn";
  if (checks.every((c) => c.status === "skip")) return "skip";
  return "pass";
}

export function tipsForReport(checks: HealthCheckResult[]): string[] {
  const tips: string[] = [];
  const byId = Object.fromEntries(checks.map((c) => [c.id, c]));

  if (byId.api?.status === "fail") {
    tips.push("Wake the API: open your Render /health URL once, wait ~30s, then re-run.");
    tips.push("Confirm Vercel NEXT_PUBLIC_API_URL is https://… and rebuild after changing it.");
  }
  if (byId.ws?.status === "fail") {
    tips.push("WebSocket failed — usually cold API or wrong API URL (must be https → wss).");
  }
  if (byId.mic?.status === "fail") {
    tips.push("Allow microphone permission for this site in Safari Settings → Websites → Microphone.");
  }
  if (byId.worklet?.status === "fail") {
    tips.push("Delete the Setu home-screen app / clear site data — stale service worker can pin a broken VAD file.");
  }
  if (byId.vad?.status === "warn" || byId.vad?.status === "fail") {
    tips.push("Hold the phone like a call and speak clearly for 1–2 seconds during the mic check.");
  }
  if (byId.tts?.status === "fail") {
    tips.push("Tap Run again (iOS needs a user gesture). If it keeps failing, force-quit Safari and reopen.");
  }
  if (tips.length === 0 && scoreOverall(checks) === "pass") {
    tips.push("All green — go back to Setu and tap the orb. Speak close to the phone, then pause.");
  }
  return tips;
}

export function buildHealthReport(checks: HealthCheckResult[]): HealthReport {
  return {
    overall: scoreOverall(checks),
    checks,
    tips: tipsForReport(checks),
    at: Date.now(),
  };
}

/** Score a short mic sample window (testable without getUserMedia). */
export function scoreMicSample(options: {
  frames: number;
  rmsMax: number;
  rmsAvg: number;
}): HealthCheckResult {
  const { frames, rmsMax, rmsAvg } = options;
  if (frames < 10) {
    return {
      id: "vad",
      label: "Voice detector",
      status: "fail",
      detail: `Only ${frames} audio frames — worklet may be dead or AudioContext suspended.`,
    };
  }
  if (rmsMax < 0.002) {
    return {
      id: "vad",
      label: "Voice detector",
      status: "fail",
      detail: `Mic frames alive but silent (rms_max=${rmsMax.toFixed(4)}). Check mute / wrong input.`,
    };
  }
  if (rmsMax < MIC_LIVE_RMS_MIN) {
    return {
      id: "vad",
      label: "Voice detector",
      status: "warn",
      detail: `Hearing room tone only (rms_max=${rmsMax.toFixed(4)}). Speak closer — close-talk needs ~${MIC_CLOSE_TALK_RMS_HINT}+.`,
    };
  }
  if (rmsMax < MIC_CLOSE_TALK_RMS_HINT) {
    return {
      id: "vad",
      label: "Voice detector",
      status: "warn",
      detail: `Speech is soft (rms_max=${rmsMax.toFixed(4)}, avg=${rmsAvg.toFixed(4)}). Hold phone nearer for best turns.`,
    };
  }
  return {
    id: "vad",
    label: "Voice detector",
    status: "pass",
    detail: `Close-talk energy seen (rms_max=${rmsMax.toFixed(4)}, avg=${rmsAvg.toFixed(4)}, frames=${frames}).`,
  };
}

export function formatHealthReportText(report: HealthReport): string {
  const lines = [
    `Setu Voice Health — ${report.overall.toUpperCase()}`,
    new Date(report.at).toISOString(),
    "",
    ...report.checks.map(
      (c) => `${c.status.toUpperCase()}  ${c.label}: ${c.detail}${c.ms != null ? ` (${c.ms}ms)` : ""}`,
    ),
    "",
    "Tips:",
    ...report.tips.map((t) => `• ${t}`),
  ];
  return lines.join("\n");
}

export function isHttpsApiUrl(apiUrl: string): boolean {
  return /^https:\/\//i.test(apiUrl.trim());
}

export function scoreApiUrlConfig(apiUrl: string, isSecurePage: boolean): HealthCheckResult {
  if (!apiUrl) {
    return { id: "config", label: "API config", status: "fail", detail: "NEXT_PUBLIC_API_URL is empty." };
  }
  if (isSecurePage && !isHttpsApiUrl(apiUrl) && !/localhost|127\.0\.0\.1/i.test(apiUrl)) {
    return {
      id: "config",
      label: "API config",
      status: "fail",
      detail: `Page is HTTPS but API is ${apiUrl} — iPhone blocks mixed-content WebSockets.`,
    };
  }
  return {
    id: "config",
    label: "API config",
    status: "pass",
    detail: apiUrl,
  };
}
