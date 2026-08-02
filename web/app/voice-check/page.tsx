"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { API_URL } from "@/lib/api";
import { ensureGuestUser, getStoredUserId } from "@/lib/auth";
import { ensureVadWorklet, getVadWorkletUrl } from "@/lib/audio/worklet-vad";
import {
  ensureMicSession,
  getMicStreamState,
  releaseMicSession,
} from "@/lib/audio/mic-session";
import {
  ensureSharedAudioElement,
  unlockSharedAudioElement,
} from "@/lib/audio/shared-audio-element";
import { wakeApiForVoice, WS_CONNECT_TIMEOUT_MS } from "@/lib/voice-session";
import {
  buildHealthReport,
  formatHealthReportText,
  scoreApiUrlConfig,
  scoreMicSample,
  type HealthCheckResult,
  type HealthReport,
} from "@/lib/voice-health";
import { shareSetuDebugLog, voiceClientLog } from "@/lib/debug";

type Phase = "idle" | "running" | "done";

function statusColor(status: string): string {
  if (status === "pass") return "#15803d";
  if (status === "warn") return "#b45309";
  if (status === "fail") return "#b91c1c";
  return "#64748b";
}

async function probeWebSocket(): Promise<HealthCheckResult> {
  const t0 = performance.now();
  const userId = getStoredUserId() || (await ensureGuestUser());
  const http = API_URL.replace(/\/$/, "");
  const wsBase = http.startsWith("https://")
    ? `wss://${http.slice("https://".length)}`
    : http.startsWith("http://")
      ? `ws://${http.slice("http://".length)}`
      : `ws://${http}`;
  const url = `${wsBase}/ws/voice?user_id=${encodeURIComponent(userId)}`;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: HealthCheckResult) => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      finish({
        id: "ws",
        label: "Voice WebSocket",
        status: "fail",
        detail: error instanceof Error ? error.message : "Could not open WebSocket",
        ms: Math.round(performance.now() - t0),
      });
      return;
    }

    const timer = window.setTimeout(() => {
      finish({
        id: "ws",
        label: "Voice WebSocket",
        status: "fail",
        detail: `No ready within ${WS_CONNECT_TIMEOUT_MS}ms (API cold start?)`,
        ms: Math.round(performance.now() - t0),
      });
    }, Math.min(WS_CONNECT_TIMEOUT_MS, 20000));

    socket.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as { type?: string };
        if (msg.type === "ready") {
          window.clearTimeout(timer);
          finish({
            id: "ws",
            label: "Voice WebSocket",
            status: "pass",
            detail: "ready handshake ok",
            ms: Math.round(performance.now() - t0),
          });
        }
      } catch {
        /* ignore */
      }
    };
    socket.onerror = () => {
      window.clearTimeout(timer);
      finish({
        id: "ws",
        label: "Voice WebSocket",
        status: "fail",
        detail: "socket error",
        ms: Math.round(performance.now() - t0),
      });
    };
  });
}

async function probeMicAndVad(
  onLevel: (rms: number) => void,
): Promise<{ mic: HealthCheckResult; worklet: HealthCheckResult; vad: HealthCheckResult }> {
  const t0 = performance.now();
  try {
    const session = await ensureMicSession({ turnId: 0 });
    const state = getMicStreamState(session.stream);
    const mic: HealthCheckResult = {
      id: "mic",
      label: "Microphone",
      status: state.live_tracks > 0 ? "pass" : "fail",
      detail: state.live_tracks > 0
        ? `Live tracks=${state.live_tracks} path=${session.path} acquire=${session.acquireMs}ms`
        : "No live mic tracks",
      ms: Math.round(performance.now() - t0),
    };

    const tw = performance.now();
    try {
      await ensureVadWorklet(session.context);
    } catch (error) {
      return {
        mic,
        worklet: {
          id: "worklet",
          label: "VAD worklet",
          status: "fail",
          detail: `${error instanceof Error ? error.message : "addModule failed"} (${getVadWorkletUrl()})`,
          ms: Math.round(performance.now() - tw),
        },
        vad: {
          id: "vad",
          label: "Voice detector",
          status: "fail",
          detail: "Skipped — worklet failed to load",
        },
      };
    }

    const worklet: HealthCheckResult = {
      id: "worklet",
      label: "VAD worklet",
      status: "pass",
      detail: `Loaded ${getVadWorkletUrl()}`,
      ms: Math.round(performance.now() - tw),
    };

    // Sample ~2.2s of RMS while user should speak.
    const { context, stream } = session;
    const source = context.createMediaStreamSource(stream);
    const workletNode = new AudioWorkletNode(context, "vad-processor");
    const silence = context.createGain();
    silence.gain.value = 0;
    source.connect(workletNode);
    workletNode.connect(silence);
    silence.connect(context.destination);

    let frames = 0;
    let sum = 0;
    let max = 0;
    workletNode.port.onmessage = (event: MessageEvent) => {
      const data = event.data as { rms?: number };
      const rms = data.rms ?? 0;
      frames += 1;
      sum += rms;
      max = Math.max(max, rms);
      onLevel(rms);
    };

    await new Promise((r) => window.setTimeout(r, 2200));

    workletNode.port.onmessage = null;
    try {
      workletNode.disconnect();
      source.disconnect();
      silence.disconnect();
    } catch {
      /* ignore */
    }

    const vad = scoreMicSample({
      frames,
      rmsMax: max,
      rmsAvg: frames ? sum / frames : 0,
    });
    return { mic, worklet, vad };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "mic failed";
    return {
      mic: {
        id: "mic",
        label: "Microphone",
        status: "fail",
        detail,
        ms: Math.round(performance.now() - t0),
      },
      worklet: { id: "worklet", label: "VAD worklet", status: "skip", detail: "Skipped — mic failed" },
      vad: { id: "vad", label: "Voice detector", status: "skip", detail: "Skipped — mic failed" },
    };
  }
}

async function probeTtsUnlock(): Promise<HealthCheckResult> {
  const t0 = performance.now();
  unlockSharedAudioElement();
  const audio = ensureSharedAudioElement();
  try {
    // Tiny silent clip — proves play() works after gesture.
    audio.src =
      "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=";
    await audio.play();
    audio.pause();
    audio.removeAttribute("src");
    return {
      id: "tts",
      label: "Speaker unlock",
      status: "pass",
      detail: "HTMLAudioElement play() ok (iOS gesture path)",
      ms: Math.round(performance.now() - t0),
    };
  } catch (error) {
    return {
      id: "tts",
      label: "Speaker unlock",
      status: "fail",
      detail: error instanceof Error ? error.message : "play() blocked",
      ms: Math.round(performance.now() - t0),
    };
  }
}

export default function VoiceCheckPage() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [report, setReport] = useState<HealthReport | null>(null);
  const [liveRms, setLiveRms] = useState(0);
  const [statusLine, setStatusLine] = useState("Tap Run — then speak for 2 seconds");
  const secure = typeof window !== "undefined" ? window.location.protocol === "https:" : true;

  const configCheck = useMemo(
    () => scoreApiUrlConfig(API_URL, secure),
    [secure],
  );

  const run = useCallback(async () => {
    setPhase("running");
    setReport(null);
    setLiveRms(0);
    voiceClientLog("voice_health_start", { api: API_URL });

    const checks: HealthCheckResult[] = [configCheck];

    setStatusLine("Waking API…");
    const wake = await wakeApiForVoice();
    checks.push({
      id: "api",
      label: "API /health",
      status: wake.ok ? "pass" : "fail",
      detail: wake.ok ? "API awake" : "Health ping failed (cold start or wrong URL)",
      ms: wake.ms,
    });

    setStatusLine("Unlocking speaker…");
    checks.push(await probeTtsUnlock());

    setStatusLine("Speak now — checking mic + VAD…");
    const { mic, worklet, vad } = await probeMicAndVad((rms) => setLiveRms(rms));
    checks.push(mic, worklet, vad);

    setStatusLine("Checking voice WebSocket…");
    checks.push(await probeWebSocket());

    releaseMicSession();
    const next = buildHealthReport(checks);
    setReport(next);
    setPhase("done");
    setStatusLine(next.overall === "pass" ? "Ready for Setu" : "Fix the red/amber items, then re-run");
    voiceClientLog("voice_health_done", { overall: next.overall });
  }, [configCheck]);

  const shareReport = useCallback(async () => {
    if (!report) return;
    const text = formatHealthReportText(report);
    const nav = navigator as Navigator & { share?: (d: { title?: string; text?: string }) => Promise<void> };
    try {
      if (nav.share) {
        await nav.share({ title: "Setu Voice Health", text });
        return;
      }
    } catch {
      /* fall through */
    }
    try {
      await navigator.clipboard.writeText(text);
      setStatusLine("Report copied");
    } catch {
      setStatusLine("Could not share — use Copy debug log on main app with ?debug=1");
    }
  }, [report]);

  return (
    <main
      className="min-h-dvh px-5 pb-10 pt-[max(1.25rem,env(safe-area-inset-top))]"
      style={{
        background:
          "radial-gradient(120% 80% at 50% -10%, #ffe8d6 0%, #f7f4ef 45%, #eef2f7 100%)",
      }}
    >
      <div className="mx-auto w-full max-w-md">
        <div className="mb-6 flex items-center justify-between gap-3">
          <Link href="/" className="text-sm font-medium text-slate-600 underline-offset-2 hover:underline">
            ← Setu
          </Link>
          <button
            type="button"
            onClick={() => void shareSetuDebugLog()}
            className="text-xs font-semibold text-slate-500"
          >
            Share debug log
          </button>
        </div>

        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-orange-700/80">Anywhere test</p>
        <h1 className="font-display mt-1 text-4xl text-slate-900">Voice Health</h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-600">
          One tap checks API, mic, VAD worklet, speaker unlock, and WebSocket — use this on iPhone before a demo.
        </p>

        <div className="mt-6 rounded-2xl bg-white/70 p-4 shadow-sm ring-1 ring-black/5">
          <div className="flex items-end justify-between gap-3">
            <div>
              <p className="text-xs font-medium text-slate-500">Live mic level</p>
              <p className="font-mono text-2xl text-slate-900">{liveRms.toFixed(4)}</p>
            </div>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-200">
              <div
                className="h-full rounded-full bg-orange-500 transition-[width] duration-75"
                style={{ width: `${Math.min(100, liveRms * 400)}%` }}
              />
            </div>
          </div>
          <p className="mt-3 text-sm text-slate-600">{statusLine}</p>
        </div>

        <button
          type="button"
          disabled={phase === "running"}
          onClick={() => void run()}
          className="mt-5 w-full rounded-2xl bg-slate-900 px-4 py-4 text-base font-semibold text-white disabled:opacity-50"
        >
          {phase === "running" ? "Running… speak now" : "Run voice check"}
        </button>

        {report && (
          <section className="mt-6 space-y-3">
            <div
              className="rounded-2xl px-4 py-3 text-sm font-semibold text-white"
              style={{ background: statusColor(report.overall) }}
            >
              Overall: {report.overall.toUpperCase()}
            </div>
            <ul className="space-y-2">
              {report.checks.map((c) => (
                <li key={c.id} className="rounded-xl bg-white/80 px-3 py-3 ring-1 ring-black/5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-slate-800">{c.label}</span>
                    <span className="text-xs font-bold uppercase" style={{ color: statusColor(c.status) }}>
                      {c.status}
                    </span>
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-slate-600">
                    {c.detail}
                    {c.ms != null ? ` · ${c.ms}ms` : ""}
                  </p>
                </li>
              ))}
            </ul>
            {report.tips.length > 0 && (
              <div className="rounded-xl bg-amber-50 px-3 py-3 text-sm text-amber-950 ring-1 ring-amber-200/80">
                <p className="font-semibold">What to do</p>
                <ul className="mt-1 list-disc space-y-1 pl-4 text-xs leading-relaxed">
                  {report.tips.map((tip) => (
                    <li key={tip}>{tip}</li>
                  ))}
                </ul>
              </div>
            )}
            <button
              type="button"
              onClick={() => void shareReport()}
              className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-800"
            >
              Share / copy report
            </button>
            <Link
              href="/"
              className="block w-full rounded-2xl bg-orange-600 px-4 py-3 text-center text-sm font-semibold text-white"
            >
              Open Setu
            </Link>
          </section>
        )}

        <p className="mt-8 text-center text-[11px] text-slate-400">
          {API_URL}
        </p>
      </div>
    </main>
  );
}
