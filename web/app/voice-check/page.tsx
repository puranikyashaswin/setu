"use client";

import Image from "next/image";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  HEALTH_STEPS,
  autorunVoiceCheckPath,
  buildHealthReport,
  collectEnvSnapshot,
  formatHealthReportText,
  parseAutorunFlag,
  scoreApiUrlConfig,
  scoreMicSample,
  stripAutorunFromSearch,
  type CheckStatus,
  type HealthCheckResult,
  type HealthReport,
} from "@/lib/voice-health";
import { haptic, hapticForOverall } from "@/lib/haptics";
import { shareSetuDebugLog, voiceClientLog } from "@/lib/debug";

type Phase = "idle" | "running" | "done";
type StepId = (typeof HEALTH_STEPS)[number]["id"];

const SPEAK_MS = 2200;
const IDLE_HINT = "Tap Run — hold the phone like a call, then speak";
const AUTORUN_HINT = "Autorun ready — tap anywhere once to start";

function statusTone(status: CheckStatus | string): string {
  if (status === "pass") return "#15803d";
  if (status === "warn") return "#b45309";
  if (status === "fail") return "#b91c1c";
  return "#64748b";
}

function statusMark(status: CheckStatus | string): string {
  if (status === "pass") return "✓";
  if (status === "warn") return "!";
  if (status === "fail") return "×";
  return "·";
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

    await new Promise((r) => window.setTimeout(r, SPEAK_MS));

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

function MicOrb({
  rms,
  speaking,
  phase,
}: {
  rms: number;
  speaking: boolean;
  phase: Phase;
}) {
  const level = Math.min(1, rms * 12);
  const scale = 1 + level * 0.28;
  const ring = 40 + level * 55;

  return (
    <div className="relative mx-auto grid h-44 w-44 place-items-center">
      <motion.div
        className="absolute inset-0 rounded-full"
        style={{
          background:
            "radial-gradient(circle at 35% 30%, rgba(255,237,213,0.9), rgba(255,107,0,0.18) 55%, transparent 70%)",
        }}
        animate={speaking ? { opacity: [0.55, 0.95, 0.55] } : { opacity: 0.7 }}
        transition={{ duration: 1.4, repeat: speaking ? Infinity : 0, ease: "easeInOut" }}
      />
      <motion.div
        className="absolute rounded-full border border-[#ff6b00]/35"
        style={{ width: `${ring}%`, height: `${ring}%` }}
        animate={speaking ? { scale: [1, 1.08, 1], opacity: [0.35, 0.7, 0.35] } : { scale: 1, opacity: 0.25 }}
        transition={{ duration: 1.1, repeat: speaking ? Infinity : 0 }}
      />
      <motion.div
        className="relative grid h-28 w-28 place-items-center rounded-full shadow-[0_22px_50px_-18px_rgba(255,107,0,0.55)]"
        style={{
          background:
            "radial-gradient(circle at 32% 26%, #fff7ed 0%, #ffc99a 22%, #ff6b00 52%, #8b83e6 86%, #4f46e5 100%)",
        }}
        animate={{ scale }}
        transition={{ type: "spring", stiffness: 260, damping: 22 }}
      >
        <span className="font-display text-2xl text-white drop-shadow-sm">
          {phase === "idle" ? "Go" : phase === "running" ? (speaking ? "Speak" : "…") : "Done"}
        </span>
      </motion.div>
    </div>
  );
}

function VoiceCheckFallback() {
  return (
    <main className="grid min-h-dvh place-items-center bg-[#fff7ed] px-5">
      <p className="font-display text-2xl text-[#172033]">Voice Health</p>
    </main>
  );
}

function VoiceCheckPageInner() {
  const searchParams = useSearchParams();
  const wantsAutorun = parseAutorunFlag(searchParams.toString());
  const [phase, setPhase] = useState<Phase>("idle");
  const [report, setReport] = useState<HealthReport | null>(null);
  const [liveRms, setLiveRms] = useState(0);
  const [statusLine, setStatusLine] = useState(IDLE_HINT);
  const [activeStep, setActiveStep] = useState<StepId | null>(null);
  const [doneSteps, setDoneSteps] = useState<Partial<Record<StepId, CheckStatus>>>({});
  const [speaking, setSpeaking] = useState(false);
  const [speakEndsAt, setSpeakEndsAt] = useState<number | null>(null);
  const [speakLeft, setSpeakLeft] = useState(0);
  const [autorunDismissed, setAutorunDismissed] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const phaseRef = useRef<Phase>("idle");
  const runLockRef = useRef(false);
  const runRef = useRef<() => Promise<void>>(async () => {});
  const secure = typeof window !== "undefined" ? window.location.protocol === "https:" : true;
  const autorunArmed = wantsAutorun && !autorunDismissed && phase === "idle";
  const shownStatus = autorunArmed ? AUTORUN_HINT : statusLine;

  const configCheck = useMemo(
    () => scoreApiUrlConfig(API_URL, secure),
    [secure],
  );

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    if (speakEndsAt == null) return;
    const id = window.setInterval(() => {
      setSpeakLeft(Math.max(0, Math.ceil((speakEndsAt - Date.now()) / 1000)));
    }, 200);
    return () => window.clearInterval(id);
  }, [speakEndsAt]);

  const markStep = useCallback((id: StepId, status: CheckStatus) => {
    setDoneSteps((prev) => ({ ...prev, [id]: status }));
    setActiveStep(id);
    if (status === "fail") void haptic("fail");
    else if (status === "warn") void haptic("warn");
    else if (status === "pass" && (id === "vad" || id === "ws")) void haptic("step");
  }, []);

  const clearAutorunQuery = useCallback(() => {
    if (typeof window === "undefined") return;
    const next = stripAutorunFromSearch(window.location.search);
    const url = `${window.location.pathname}${next}${window.location.hash}`;
    window.history.replaceState({}, "", url);
  }, []);

  const beginSpeakWindow = useCallback(() => {
    const ends = Date.now() + SPEAK_MS;
    setSpeakEndsAt(ends);
    setSpeakLeft(Math.ceil(SPEAK_MS / 1000));
    setSpeaking(true);
  }, []);

  const endSpeakWindow = useCallback(() => {
    setSpeaking(false);
    setSpeakEndsAt(null);
    setSpeakLeft(0);
  }, []);

  const run = useCallback(async () => {
    if (runLockRef.current || phaseRef.current === "running") return;
    runLockRef.current = true;
    setAutorunDismissed(true);
    clearAutorunQuery();
    void haptic("tap");

    setPhase("running");
    phaseRef.current = "running";
    setReport(null);
    setLiveRms(0);
    endSpeakWindow();
    setDoneSteps({});
    setActiveStep("config");
    voiceClientLog("voice_health_start", { api: API_URL });

    try {
      const checks: HealthCheckResult[] = [configCheck];
      markStep("config", configCheck.status);

      setStatusLine("Waking API…");
      setActiveStep("api");
      const wake = await wakeApiForVoice();
      const apiCheck: HealthCheckResult = {
        id: "api",
        label: "API /health",
        status: wake.ok ? "pass" : "fail",
        detail: wake.ok ? "API awake" : "Health ping failed (cold start or wrong URL)",
        ms: wake.ms,
      };
      checks.push(apiCheck);
      markStep("api", apiCheck.status);

      setStatusLine("Unlocking speaker…");
      setActiveStep("tts");
      const tts = await probeTtsUnlock();
      checks.push(tts);
      markStep("tts", tts.status);

      setStatusLine("Speak now — close to the phone");
      beginSpeakWindow();
      setActiveStep("mic");
      const { mic, worklet, vad } = await probeMicAndVad((rms) => setLiveRms(rms));
      endSpeakWindow();
      checks.push(mic, worklet, vad);
      markStep("mic", mic.status);
      markStep("worklet", worklet.status);
      markStep("vad", vad.status);

      setStatusLine("Checking voice WebSocket…");
      setActiveStep("ws");
      const ws = await probeWebSocket();
      checks.push(ws);
      markStep("ws", ws.status);

      releaseMicSession();
      const next = buildHealthReport(checks, collectEnvSnapshot(API_URL));
      setReport(next);
      setPhase("done");
      phaseRef.current = "done";
      setActiveStep(null);
      void hapticForOverall(next.overall);
      setStatusLine(
        next.overall === "pass"
          ? "All green — Setu is ready on this device"
          : "Fix amber/red items, then re-run",
      );
      voiceClientLog("voice_health_done", { overall: next.overall });
    } catch (error) {
      endSpeakWindow();
      releaseMicSession();
      setPhase("idle");
      phaseRef.current = "idle";
      setStatusLine(error instanceof Error ? error.message : "Check failed — try again");
      void haptic("fail");
    } finally {
      runLockRef.current = false;
    }
  }, [beginSpeakWindow, clearAutorunQuery, configCheck, endSpeakWindow, markStep]);

  useEffect(() => {
    runRef.current = run;
  }, [run]);

  // ?autorun=1 — iPhone needs a gesture for mic/TTS; tap anywhere once to start.
  useEffect(() => {
    if (!autorunArmed) return;
    voiceClientLog("voice_health_autorun_armed", {});

    const onGesture = (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("a[href], button[data-no-autorun]")) return;
      if (phaseRef.current !== "idle" || runLockRef.current) return;
      void runRef.current();
    };

    window.addEventListener("pointerdown", onGesture, { capture: true });
    return () => window.removeEventListener("pointerdown", onGesture, { capture: true });
  }, [autorunArmed]);

  const copyAutorunLink = useCallback(async () => {
    const url = `${window.location.origin}${autorunVoiceCheckPath()}`;
    try {
      await navigator.clipboard.writeText(url);
      setLinkCopied(true);
      void haptic("tap");
      window.setTimeout(() => setLinkCopied(false), 1600);
    } catch {
      setStatusLine("Could not copy link");
    }
  }, []);

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
      setStatusLine("Could not share — try Share debug log");
    }
  }, [report]);

  const passCount = report?.checks.filter((c) => c.status === "pass").length ?? 0;
  const totalCount = report?.checks.length ?? HEALTH_STEPS.length;

  return (
    <main className="relative min-h-dvh overflow-hidden px-5 pb-12 pt-[max(1.25rem,env(safe-area-inset-top))]">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(90% 60% at 50% -8%, #ffd7b0 0%, #fff7ed 38%, #f8fafc 72%, #eef2ff 100%)",
        }}
      />
      <div aria-hidden className="grain pointer-events-none absolute inset-0" />

      <div className="relative mx-auto w-full max-w-md">
        <div className="mb-5 flex items-center justify-between gap-3">
          <Link
            href="/"
            className="flex items-center gap-2 text-sm font-medium text-slate-600"
          >
            <Image src="/logo.png" alt="" width={36} height={20} className="h-5 w-auto" draggable={false} />
            <span>Setu</span>
          </Link>
          <button
            type="button"
            data-no-autorun
            onClick={() => void shareSetuDebugLog()}
            className="text-xs font-semibold text-slate-500"
          >
            Debug log
          </button>
        </div>

        <AnimatePresence>
          {autorunArmed && phase === "idle" && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              className="mb-4 rounded-2xl bg-[#172033] px-4 py-3 text-white shadow-[0_14px_28px_rgba(23,32,51,0.2)]"
            >
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#ffb080]">
                Autorun
              </p>
              <p className="mt-1 text-sm font-medium leading-snug">
                Tap anywhere once — check starts immediately (iPhone needs this gesture for mic).
              </p>
            </motion.div>
          )}
        </AnimatePresence>

        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#c2410c]">
          Anywhere test
        </p>
        <h1 className="font-display mt-1 text-[2.75rem] leading-none tracking-[-0.03em] text-[#172033]">
          Voice Health
        </h1>
        <p className="mt-2 max-w-sm text-sm leading-relaxed text-slate-600">
          One tap proves this phone can hear you, talk back, and reach Setu — before a demo.
        </p>

        <div className="mt-7">
          <MicOrb rms={liveRms} speaking={speaking} phase={phase} />
          <div className="mt-2 text-center">
            <p className="text-sm font-medium text-slate-700">{shownStatus}</p>
            {speaking && (
              <p className="mt-1 text-xs font-semibold tracking-wide text-[#ff6b00]">
                Keep speaking · {speakLeft}s
              </p>
            )}
            {!speaking && phase !== "idle" && (
              <p className="mt-1 font-mono text-[11px] text-slate-400">
                rms {liveRms.toFixed(4)}
              </p>
            )}
          </div>
        </div>

        <ol className="mt-6 flex justify-between gap-1">
          {HEALTH_STEPS.map((step) => {
            const status = doneSteps[step.id];
            const active = activeStep === step.id && phase === "running";
            return (
              <li key={step.id} className="flex flex-1 flex-col items-center gap-1.5">
                <span
                  className={`grid h-7 w-7 place-items-center rounded-full text-[11px] font-bold transition ${
                    active
                      ? "bg-[#ff6b00] text-white shadow-[0_6px_14px_rgba(255,107,0,0.35)]"
                      : status
                        ? "text-white"
                        : "bg-white/70 text-slate-400 ring-1 ring-slate-200"
                  }`}
                  style={status && !active ? { background: statusTone(status) } : undefined}
                >
                  {active ? "·" : status ? statusMark(status) : ""}
                </span>
                <span className={`text-[9px] font-semibold tracking-wide ${active ? "text-[#c2410c]" : "text-slate-400"}`}>
                  {step.label}
                </span>
              </li>
            );
          })}
        </ol>

        <motion.button
          type="button"
          disabled={phase === "running"}
          onClick={() => void run()}
          className={`mt-6 w-full rounded-full px-4 py-4 text-base font-semibold text-white disabled:opacity-50 ${
            autorunArmed && phase === "idle"
              ? "bg-[#ff6b00] shadow-[0_14px_32px_rgba(255,107,0,0.35)]"
              : "bg-[#172033] shadow-[0_14px_32px_rgba(23,32,51,0.22)]"
          }`}
          animate={
            autorunArmed && phase === "idle"
              ? { scale: [1, 1.02, 1] }
              : { scale: 1 }
          }
          transition={
            autorunArmed && phase === "idle"
              ? { duration: 1.2, repeat: Infinity, ease: "easeInOut" }
              : undefined
          }
        >
          {phase === "running"
            ? speaking
              ? "Listening…"
              : "Running checks…"
            : phase === "done"
              ? "Run again"
              : autorunArmed
                ? "Tap to start"
                : "Run voice check"}
        </motion.button>

        <button
          type="button"
          data-no-autorun
          onClick={() => void copyAutorunLink()}
          className="mt-3 w-full text-center text-xs font-semibold text-slate-500"
        >
          {linkCopied ? "Copied autorun link" : "Copy demo link (?autorun=1)"}
        </button>

        <AnimatePresence>
          {report && (
            <motion.section
              className="mt-6 space-y-3"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.28 }}
            >
              <div
                className="overflow-hidden rounded-2xl px-4 py-4 text-white shadow-[0_16px_36px_rgba(15,23,42,0.12)]"
                style={{
                  background:
                    report.overall === "pass"
                      ? "linear-gradient(135deg, #15803d, #166534)"
                      : report.overall === "warn"
                        ? "linear-gradient(135deg, #d97706, #b45309)"
                        : "linear-gradient(135deg, #dc2626, #991b1b)",
                }}
              >
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/75">
                  Overall
                </p>
                <div className="mt-1 flex items-end justify-between gap-3">
                  <p className="font-display text-3xl leading-none">
                    {report.overall === "pass" ? "Ready" : report.overall === "warn" ? "Almost" : "Needs fix"}
                  </p>
                  <p className="text-sm font-medium text-white/85">
                    {passCount}/{totalCount} pass
                  </p>
                </div>
              </div>

              <ul className="space-y-2">
                {report.checks.map((c, i) => (
                  <motion.li
                    key={c.id}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.04 }}
                    className="glass-surface rounded-2xl px-3.5 py-3"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-slate-800">{c.label}</span>
                      <span
                        className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white"
                        style={{ background: statusTone(c.status) }}
                      >
                        {c.status}
                      </span>
                    </div>
                    <p className="mt-1 text-xs leading-relaxed text-slate-600">
                      {c.detail}
                      {c.ms != null ? ` · ${c.ms}ms` : ""}
                    </p>
                  </motion.li>
                ))}
              </ul>

              {report.tips.length > 0 && (
                <div className="rounded-2xl border border-[#ff6b00]/20 bg-[#fff7ed] px-3.5 py-3">
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#9a3412]">
                    What to do
                  </p>
                  <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-[#7c2d12]">
                    {report.tips.map((tip) => (
                      <li key={tip} className="flex gap-2">
                        <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-[#ff6b00]" />
                        <span>{tip}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {report.env && (
                <p className="px-1 text-[10px] leading-relaxed text-slate-400">
                  {report.env.platform} · {report.env.viewport} · sw {report.env.sw}
                  {report.env.secure ? "" : " · insecure"}
                </p>
              )}

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => void shareReport()}
                  className="rounded-full border border-slate-200 bg-white/80 px-4 py-3 text-sm font-semibold text-slate-800"
                >
                  Share report
                </button>
                <Link
                  href="/"
                  className="rounded-full bg-[#ff6b00] px-4 py-3 text-center text-sm font-semibold text-white shadow-[0_10px_24px_rgba(255,107,0,0.28)]"
                >
                  Open Setu
                </Link>
              </div>
            </motion.section>
          )}
        </AnimatePresence>

        <p className="mt-8 truncate text-center text-[10px] text-slate-400">{API_URL}</p>
      </div>
    </main>
  );
}

export default function VoiceCheckPage() {
  return (
    <Suspense fallback={<VoiceCheckFallback />}>
      <VoiceCheckPageInner />
    </Suspense>
  );
}
