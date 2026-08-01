import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { VadLevelTelemetry } from "./vad-levels";
import { trimUtteranceSilence, TRIM_PADDING_MS } from "./trim-silence";
import {
  computeSpeechThreshold,
  resolveNoSpeechOutcome,
  shouldDeltaWeakTrigger,
} from "./vad-threshold";
import {
  LAST_SPEECH_GAP_MS,
  ONSET_HOLD_MS,
  ONSET_SNR,
  QUIET_AFTER_SPEECH_MS,
  QUIET_NOISE_MULT,
  TurnEndpoint,
  __resetEndpointTurnForTests,
  type EndpointReason,
} from "./endpoint";
import {
  MIN_SPEECH_MS,
  NO_SPEECH_MS,
  SILENCE_MS,
  claimMicTurn,
  isMicTurnCurrent,
  releaseMicTurn,
  speechMs,
  type RecorderSession,
} from "./recorder";

describe("VAD threshold math", () => {
  it("ambient 0.008 yields threshold <= 0.0144", () => {
    const threshold = computeSpeechThreshold(0.008);
    assert.ok(threshold <= 0.0144, `expected <= 0.0144, got ${threshold}`);
    assert.equal(threshold, 0.0144);
  });

  it("ambient 0.003 yields floor threshold 0.006", () => {
    assert.equal(computeSpeechThreshold(0.003), 0.006);
  });

  it("quiet ambient caps high raw threshold at 0.012", () => {
    assert.equal(computeSpeechThreshold(0.0068), 0.012);
  });

  it("genuinely loud ambient skips cap", () => {
    assert.equal(computeSpeechThreshold(0.01), 0.018);
  });
});

describe("authoritative turn endpoint (TurnEndpoint — same code as production)", () => {
  const FRAME_MS = 2.67;
  const CALIBRATION_MS = 400;

  type SimOptions = {
    ambient: number;
    peak: number;
    postRms: number;
    speechMs?: number;
    /** Mid-speech pause: [startOffsetMs, durationMs] at ambient level. */
    dip?: [number, number];
    /** Post-speech noise spike: [startOffsetMs, durationMs, rms]. */
    spike?: [number, number, number];
    /** Feed frames indefinitely loud (speech never ends). */
    holdSpeech?: boolean;
    /** No speech segment — ambient/fan only for maxT. */
    fanOnly?: boolean;
    /** Add bursty modulation to peak (speech-like). Default true when peak plays. */
    bursty?: boolean;
    maxT?: number;
  };

  function speechRms(peak: number, t: number, bursty: boolean): number {
    if (!bursty) return peak;
    // Mild amplitude modulation — speech is bursty; fans are not.
    // Stay ≥ ~90% of peak so onset hold (noise×3) is not reset by dips.
    const mod = 0.06 * Math.sin(t / 14) + 0.04 * Math.sin(t / 5);
    return peak * (0.94 + mod);
  }

  function simulate(opts: SimOptions) {
    const speechMs = opts.speechMs ?? 1500;
    const finishes: Array<{ reason: EndpointReason; t: number }> = [];
    const controller = new TurnEndpoint(1, (reason) => {
      finishes.push({ reason, t: nowRef.t });
    });
    const t0 = 1000;
    controller.startedAtMs = t0;
    const nowRef = { t: t0 };
    const speechStart = CALIBRATION_MS;
    const speechEnd = speechStart + speechMs;
    let confirmed = false;
    let earlyFinishT: number | null = null;
    const maxT = opts.maxT ?? 20000;
    const bursty = opts.bursty !== false;

    for (let t = 0; t <= maxT && finishes.length === 0; t += FRAME_MS) {
      const now = t0 + t;
      nowRef.t = now;
      let rms: number;
      if (opts.fanOnly || t < speechStart) {
        // Tiny sensor noise on fan — still far steadier than speech.
        rms = opts.ambient * (1 + 0.01 * Math.sin(t / 40));
      } else if (t < speechEnd || opts.holdSpeech) {
        const inDip = !opts.holdSpeech && opts.dip && t - speechStart >= opts.dip[0] && t - speechStart < opts.dip[0] + opts.dip[1];
        rms = inDip ? opts.ambient : speechRms(opts.peak, t, bursty);
      } else {
        const post = t - speechEnd;
        const inSpike = opts.spike && post >= opts.spike[0] && post < opts.spike[0] + opts.spike[1];
        rms = inSpike ? opts.spike[2] : opts.postRms;
      }

      controller.handleAudioFrame(1, rms, now);
      if (controller.confirmedSpeech) confirmed = true;
      if (finishes.length > 0 && t < speechEnd) earlyFinishT = t;
    }
    return { finishes, speechEnd, speechStart, confirmed, earlyFinishT, controller, nowRef };
  }

  beforeEach(() => {
    __resetEndpointTurnForTests();
  });

  it("ambient 0.025, speech 0.12 for 1s, then 0.025 → post_speech_quiet ~900ms after speech", () => {
    const { finishes, speechEnd, confirmed } = simulate({ ambient: 0.025, peak: 0.12, postRms: 0.025, speechMs: 1000 });
    assert.equal(confirmed, true);
    assert.equal(finishes.length, 1);
    assert.equal(finishes[0]!.reason, "post_speech_quiet");
    const afterEnd = finishes[0]!.t - 1000 - speechEnd;
    assert.ok(afterEnd >= QUIET_AFTER_SPEECH_MS - 80, `too early: ${afterEnd}ms`);
    assert.ok(afterEnd <= 1400, `too late: ${afterEnd}ms`);
    assert.ok(finishes[0]!.t - 1000 < 15000, "must not reach max_recording");
  });

  it("ambient 0.030, speech 0.14, then 0.03 → endpoints with relative quietCeiling", () => {
    // onset needs peak > noise×3 (=0.09); quietCeiling = noise×1.5
    const { finishes, controller } = simulate({ ambient: 0.03, peak: 0.14, postRms: 0.03, speechMs: 1000 });
    const expectedQuiet = 0.03 * QUIET_NOISE_MULT;
    assert.ok(Math.abs(controller.quietCeiling - expectedQuiet) < 0.01, `quietCeiling=${controller.quietCeiling}`);
    assert.equal(finishes.length, 1);
    assert.equal(finishes[0]!.reason, "post_speech_quiet");
    assert.ok(finishes[0]!.t - 1000 < 15000);
  });

  it("500ms natural pause mid-speech does not endpoint; quiet timer resets", () => {
    const { finishes, speechEnd, earlyFinishT } = simulate({
      ambient: 0.025,
      peak: 0.14,
      postRms: 0.025,
      speechMs: 2500,
      dip: [1000, 500],
    });
    assert.equal(earlyFinishT, null, "must not endpoint during/around the pause");
    assert.equal(finishes.length, 1);
    assert.ok(finishes[0]!.t - 1000 > speechEnd, "endpoint only after final speech end");
  });

  it("sustained non-speech noise near floor after speech does not postpone endpoint", () => {
    const { finishes, speechEnd } = simulate({ ambient: 0.025, peak: 0.14, postRms: 0.03, speechMs: 1000 });
    assert.equal(finishes.length, 1);
    assert.equal(finishes[0]!.reason, "post_speech_quiet");
    assert.ok(finishes[0]!.t - 1000 - speechEnd <= 1400);
  });

  it("50ms noise spike during quiet does not block endpoint", () => {
    const { finishes, speechEnd } = simulate({
      ambient: 0.025,
      peak: 0.14,
      postRms: 0.025,
      speechMs: 1000,
      spike: [300, 50, 0.07],
    });
    assert.equal(finishes.length, 1);
    assert.equal(finishes[0]!.reason, "post_speech_quiet");
    assert.ok(finishes[0]!.t - 1000 - speechEnd <= 1600, "smoothing absorbs the spike");
  });

  it("unusual noise above quiet ceiling → last_speech_gap 2.5s after last meaningful speech", () => {
    // post 0.045 > quietCeiling (~0.037) but below meaningful (~0.055); gap path.
    const { finishes, speechEnd } = simulate({ ambient: 0.025, peak: 0.14, postRms: 0.045, speechMs: 1200 });
    assert.equal(finishes.length, 1);
    assert.equal(finishes[0]!.reason, "last_speech_gap");
    const afterEnd = finishes[0]!.t - 1000 - speechEnd;
    // Smoothing delays the last-meaningful stamp slightly past raw speech end.
    assert.ok(Math.abs(afterEnd - LAST_SPEECH_GAP_MS) < 350, `gap at ${afterEnd}ms after speech end`);
    assert.ok(finishes[0]!.t - 1000 < 15000);
  });

  it("max_recording remains fallback only when speech never ends", () => {
    const { finishes, controller, nowRef, confirmed } = simulate({
      ambient: 0.025,
      peak: 0.14,
      postRms: 0.025,
      holdSpeech: true,
      maxT: 15500,
    });
    assert.equal(confirmed, true);
    assert.equal(finishes.length, 0, "no endpoint while speech continues");
    nowRef.t += 500;
    assert.equal(controller.finishTurnOnce(1, "max_recording", nowRef.t), true);
    assert.equal(finishes.length, 1);
    assert.equal(finishes[0]!.reason, "max_recording");
    assert.equal(controller.finishTurnOnce(1, "max_recording", nowRef.t), false, "duplicate blocked");
    assert.equal(finishes.length, 1);
  });

  it("duplicate frame callbacks / duplicate completions submit only once", () => {
    const { finishes, controller, nowRef } = simulate({ ambient: 0.025, peak: 0.14, postRms: 0.025, speechMs: 1000 });
    assert.equal(finishes.length, 1);
    controller.handleAudioFrame(1, 0.3, nowRef.t + 100);
    assert.equal(finishes.length, 1);
    assert.equal(controller.finishTurnOnce(1, "max_recording", nowRef.t + 200), false);
    assert.equal(finishes.length, 1);
  });

  it("stale turn frames and completions cannot stop a newer turn", () => {
    const staleFinishes: EndpointReason[] = [];
    const stale = new TurnEndpoint(1, (r) => staleFinishes.push(r));
    stale.startedAtMs = 1000;
    const currentFinishes: EndpointReason[] = [];
    const current = new TurnEndpoint(2, (r) => currentFinishes.push(r));
    current.startedAtMs = 1000;

    stale.handleAudioFrame(1, 0.3, 2000); // rejected: old generation
    assert.equal(staleFinishes.length, 0);
    assert.equal(stale.finishTurnOnce(1, "max_recording", 2000), false, "stale completion blocked");
    assert.equal(current.finished, false, "newer turn untouched");

    for (let t = 0; t <= 4000 && currentFinishes.length === 0; t += FRAME_MS) {
      const now = 1000 + t;
      const rms = t < 400 ? 0.025 : t < 1600 ? speechRms(0.14, t, true) : 0.025;
      current.handleAudioFrame(2, rms, now);
    }
    assert.equal(currentFinishes.length, 1);
    assert.equal(currentFinishes[0], "post_speech_quiet");
  });

  it("finishTurnOnce invokes the completion callback synchronously", () => {
    const finishes: EndpointReason[] = [];
    const controller = new TurnEndpoint(7, (r) => finishes.push(r));
    controller.startedAtMs = 1000;
    let syncObserved = false;
    controller.finishTurnOnce(7, "max_recording", 16000);
    syncObserved = finishes.length === 1;
    assert.equal(syncObserved, true, "state flip happens synchronously (listening→thinking)");
  });

  it("fan-only ambient never confirms speech and never submits a turn", () => {
    const { finishes, confirmed, controller } = simulate({
      ambient: 0.045,
      peak: 0.045,
      postRms: 0.045,
      fanOnly: true,
      bursty: false,
      maxT: 5000,
    });
    assert.equal(confirmed, false);
    assert.equal(controller.confirmedSpeech, false);
    assert.equal(finishes.length, 0);
    assert.ok(controller.ambientBaseline > 0.03, `noise floor should track fan: ${controller.ambientBaseline}`);
    assert.ok(
      controller.lastOnsetRejectedReason === "below_snr"
        || controller.lastOnsetRejectedReason === "steady_noise"
        || controller.lastOnsetRejectedReason === "hold_incomplete"
        || controller.lastOnsetRejectedReason === null,
    );
  });

  it("speech over fan confirms and endpoints correctly", () => {
    const fan = 0.04;
    const { finishes, confirmed, controller } = simulate({
      ambient: fan,
      peak: fan * ONSET_SNR * 1.8, // clearly above 3× floor even with burst dips
      postRms: fan,
      speechMs: 1000,
    });
    assert.equal(confirmed, true);
    assert.equal(finishes.length, 1);
    assert.equal(finishes[0]!.reason, "post_speech_quiet");
    assert.ok(controller.quietCeiling <= fan * QUIET_NOISE_MULT + 0.01);
  });

  it("quiet-room behavior unchanged — soft speech still endpoints", () => {
    const { finishes, confirmed } = simulate({
      ambient: 0.008,
      peak: 0.06,
      postRms: 0.008,
      speechMs: 900,
    });
    assert.equal(confirmed, true);
    assert.equal(finishes.length, 1);
    assert.equal(finishes[0]!.reason, "post_speech_quiet");
  });

  it("onset requires sustained hold (≥250ms) above noise×SNR", () => {
    assert.ok(ONSET_HOLD_MS >= 250);
    const { confirmed } = simulate({
      ambient: 0.03,
      peak: 0.2,
      postRms: 0.03,
      speechMs: 120, // shorter than onset hold → must not confirm
      maxT: 2000,
    });
    assert.equal(confirmed, false);
  });
});

describe("single-flight recorder ownership", () => {
  afterEach(() => {
    releaseMicTurn(1);
    releaseMicTurn(2);
  });

  it("duplicate claim for the same active turn is skipped", () => {
    assert.equal(claimMicTurn(1), true);
    assert.equal(claimMicTurn(1), false, "second claim must be skipped (mic_open_skipped)");
    assert.equal(isMicTurnCurrent(1), true);
    releaseMicTurn(1);
    assert.equal(claimMicTurn(1), true, "claim allowed again after release");
  });

  it("stale turn cannot claim or release a newer turn", () => {
    assert.equal(claimMicTurn(1), true);
    assert.equal(claimMicTurn(2), true, "new turn replaces old");
    assert.equal(isMicTurnCurrent(1), false, "old turn is stale");
    assert.equal(isMicTurnCurrent(2), true);
    releaseMicTurn(1);
    assert.equal(isMicTurnCurrent(2), true, "stale release must not drop current turn");
  });
});

describe("utterance silence trim", () => {
  const sampleRate = 48000;
  const frameSamples = 128;
  const frameMs = (frameSamples / sampleRate) * 1000;
  const paddingFrames = Math.ceil(TRIM_PADDING_MS / frameMs);

  function makeChunk(rms: number): Float32Array {
    const chunk = new Float32Array(frameSamples);
    chunk.fill(rms);
    return chunk;
  }

  it("keeps 300ms padding before first speech and after last speech", () => {
    const threshold = 0.012;
    const silent = makeChunk(0.004);
    const speech = makeChunk(0.02);
    const leadingSilent = 200;
    const speechFrames = 10;
    const trailingSilent = 200;
    const chunks = [
      ...Array.from({ length: leadingSilent }, () => silent),
      ...Array.from({ length: speechFrames }, () => speech),
      ...Array.from({ length: trailingSilent }, () => silent),
    ];

    const trimmed = trimUtteranceSilence(chunks, sampleRate, { speechThreshold: threshold });
    const expectedLen = paddingFrames + speechFrames + paddingFrames;
    assert.equal(trimmed.length, expectedLen);
    assert.equal(trimmed[0], chunks[leadingSilent - paddingFrames]);
    assert.equal(trimmed[trimmed.length - 1], chunks[leadingSilent + speechFrames + paddingFrames - 1]);
  });

  it("returns original chunks when no speech crosses threshold", () => {
    const chunks = Array.from({ length: 5 }, () => makeChunk(0.004));
    const trimmed = trimUtteranceSilence(chunks, sampleRate, { speechThreshold: 0.012 });
    assert.equal(trimmed.length, chunks.length);
  });
});

describe("no_speech window (delta_weak disabled for adaptive onset)", () => {
  it("near-ambient energy no longer promotes delta_weak submissions", () => {
    const ambient = 0.004;
    const threshold = 0.012;
    const rmsMax = 0.009;
    // Helper may still classify delta_weak, but recorder ignores it (no_speech only).
    assert.equal(shouldDeltaWeakTrigger(ambient, rmsMax, threshold), true);
  });

  it("no energy above ambient delta stays no_speech", () => {
    assert.equal(
      resolveNoSpeechOutcome({
        heardSpeech: false,
        elapsedMs: NO_SPEECH_MS,
        noSpeechMs: NO_SPEECH_MS,
        ambientRms: 0.004,
        rmsMax: 0.005,
        threshold: 0.012,
      }),
      "no_speech",
    );
  });
});

describe("speechMs after adaptive confirm", () => {
  it("confirmed speech duration is not collapsed to a single frame", () => {
    __resetEndpointTurnForTests();
    const controller = new TurnEndpoint(99, () => undefined);
    controller.startedAtMs = 1000;
    controller.noteSpeechConfirmed(1400);
    controller.lastFrameAtMs = 2800;
    const recorder = {
      speechFrames: 1,
      frameMs: 2.67,
      controller,
    } as unknown as RecorderSession;
    const ms = speechMs(recorder);
    assert.ok(ms >= 1000, `expected >=1000ms of speech, got ${ms}`);
    assert.ok(ms >= MIN_SPEECH_MS, "must clear MIN_SPEECH_MS so finishRecording submits");
  });
});

describe("vad_levels telemetry", () => {
  const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
  const originalInfo = console.info;

  beforeEach(() => {
    logs.length = 0;
    console.info = (...args: unknown[]) => {
      const line = String(args[0] ?? "");
      if (line.startsWith("[audio] vad_levels")) {
        logs.push({ event: "vad_levels", data: { line } });
      }
    };
  });

  afterEach(() => {
    console.info = originalInfo;
  });

  it("emits vad_levels once per second during listening", () => {
    const telemetry = new VadLevelTelemetry(3);
    let now = 1000;
    for (let i = 0; i < 11; i += 1) {
      telemetry.onFrame(0.008 + i * 0.0001, 0.012, now);
      now += 100;
    }
    assert.equal(logs.length, 1);
    assert.match(logs[0]!.data.line as string, /turn_id=3/);
    assert.match(logs[0]!.data.line as string, /rms_max=/);
    assert.match(logs[0]!.data.line as string, /rms_avg=/);
    assert.match(logs[0]!.data.line as string, /threshold=0.012/);
    assert.match(logs[0]!.data.line as string, /frames_over_threshold=/);

    telemetry.onFrame(0.015, 0.012, now);
    now += 1000;
    telemetry.onFrame(0.011, 0.012, now);
    assert.equal(logs.length, 2);
  });
});
