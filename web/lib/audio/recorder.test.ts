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
  QUIET_AFTER_SPEECH_MS,
  TurnEndpoint,
  __resetEndpointTurnForTests,
  type EndpointReason,
} from "./endpoint";
import {
  NO_SPEECH_MS,
  SILENCE_MS,
  SPEECH_FRAMES_TO_CONFIRM,
  claimMicTurn,
  isMicTurnCurrent,
  releaseMicTurn,
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
    maxT?: number;
  };

  function simulate(opts: SimOptions) {
    const speechMs = opts.speechMs ?? 1500;
    const threshold = computeSpeechThreshold(opts.ambient);
    const finishes: Array<{ reason: EndpointReason; t: number }> = [];
    const controller = new TurnEndpoint(1, (reason) => {
      finishes.push({ reason, t: nowRef.t });
    });
    const t0 = 1000;
    controller.startedAtMs = t0;
    const nowRef = { t: t0 };
    const speechStart = CALIBRATION_MS;
    const speechEnd = speechStart + speechMs;
    let runFrames = 0;
    let confirmed = false;
    let earlyFinishT: number | null = null;
    const maxT = opts.maxT ?? 20000;

    for (let t = 0; t <= maxT && finishes.length === 0; t += FRAME_MS) {
      const now = t0 + t;
      nowRef.t = now;
      let rms: number;
      if (t < speechStart) {
        rms = opts.ambient;
      } else if (t < speechEnd || opts.holdSpeech) {
        const inDip = !opts.holdSpeech && opts.dip && t - speechStart >= opts.dip[0] && t - speechStart < opts.dip[0] + opts.dip[1];
        rms = inDip ? opts.ambient : opts.peak;
      } else {
        const post = t - speechEnd;
        const inSpike = opts.spike && post >= opts.spike[0] && post < opts.spike[0] + opts.spike[1];
        rms = inSpike ? opts.spike[2] : opts.postRms;
      }

      // Mirror recorder.ts: 24-frame confirm drives noteSpeechConfirmed.
      if (rms >= threshold) {
        runFrames += 1;
        if (runFrames >= SPEECH_FRAMES_TO_CONFIRM && !confirmed) {
          confirmed = true;
          controller.noteSpeechConfirmed(now);
        }
      } else {
        runFrames = 0;
      }

      controller.handleAudioFrame(1, rms, now);
      if (finishes.length > 0 && t < speechEnd) earlyFinishT = t;
    }
    return { finishes, speechEnd, speechStart, confirmed, earlyFinishT, controller, nowRef };
  }

  beforeEach(() => {
    __resetEndpointTurnForTests();
  });

  it("ambient 0.025, speech 0.10 for 1s, then 0.025 → post_speech_quiet ~900ms after speech", () => {
    const { finishes, speechEnd } = simulate({ ambient: 0.025, peak: 0.1, postRms: 0.025, speechMs: 1000 });
    assert.equal(finishes.length, 1);
    assert.equal(finishes[0]!.reason, "post_speech_quiet");
    const afterEnd = finishes[0]!.t - 1000 - speechEnd;
    assert.ok(afterEnd >= QUIET_AFTER_SPEECH_MS - 50, `too early: ${afterEnd}ms`);
    assert.ok(afterEnd <= 1300, `too late: ${afterEnd}ms`);
    assert.ok(finishes[0]!.t - 1000 < 15000, "must not reach max_recording");
  });

  it("ambient 0.030, speech 0.08, then 0.03 → endpoints with quietCeiling 0.048", () => {
    const { finishes, controller } = simulate({ ambient: 0.03, peak: 0.08, postRms: 0.03, speechMs: 1000 });
    assert.ok(Math.abs(controller.quietCeiling - 0.048) < 1e-9, `quietCeiling=${controller.quietCeiling}`);
    assert.equal(finishes.length, 1);
    assert.equal(finishes[0]!.reason, "post_speech_quiet");
    assert.ok(finishes[0]!.t - 1000 < 15000);
  });

  it("500ms natural pause mid-speech does not endpoint; quiet timer resets", () => {
    const { finishes, speechEnd, earlyFinishT } = simulate({
      ambient: 0.025,
      peak: 0.1,
      postRms: 0.025,
      speechMs: 2500,
      dip: [1000, 500],
    });
    assert.equal(earlyFinishT, null, "must not endpoint during/around the pause");
    assert.equal(finishes.length, 1);
    assert.ok(finishes[0]!.t - 1000 > speechEnd, "endpoint only after final speech end");
  });

  it("sustained non-speech noise 0.03 after speech does not postpone endpoint", () => {
    const { finishes, speechEnd } = simulate({ ambient: 0.025, peak: 0.1, postRms: 0.03, speechMs: 1000 });
    assert.equal(finishes.length, 1);
    assert.equal(finishes[0]!.reason, "post_speech_quiet");
    assert.ok(finishes[0]!.t - 1000 - speechEnd <= 1300);
  });

  it("50ms noise spike at 0.07 during quiet does not block endpoint", () => {
    const { finishes, speechEnd } = simulate({
      ambient: 0.025,
      peak: 0.1,
      postRms: 0.025,
      speechMs: 1000,
      spike: [300, 50, 0.07],
    });
    assert.equal(finishes.length, 1);
    assert.equal(finishes[0]!.reason, "post_speech_quiet");
    assert.ok(finishes[0]!.t - 1000 - speechEnd <= 1600, "smoothing absorbs the spike");
  });

  it("unusual noise above quiet ceiling → last_speech_gap 2.5s after last meaningful speech", () => {
    // 0.05 > quietCeiling 0.045 (quiet path blocked) but < meaningful floor 0.07.
    const { finishes, speechEnd } = simulate({ ambient: 0.025, peak: 0.1, postRms: 0.05, speechMs: 1200 });
    assert.equal(finishes.length, 1);
    assert.equal(finishes[0]!.reason, "last_speech_gap");
    const afterEnd = finishes[0]!.t - 1000 - speechEnd;
    assert.ok(Math.abs(afterEnd - LAST_SPEECH_GAP_MS) < 150, `gap at ${afterEnd}ms after speech end`);
    assert.ok(finishes[0]!.t - 1000 < 15000);
  });

  it("max_recording remains fallback only when speech never ends", () => {
    const { finishes, controller, nowRef } = simulate({
      ambient: 0.025,
      peak: 0.1,
      postRms: 0.025,
      holdSpeech: true,
      maxT: 15500,
    });
    assert.equal(finishes.length, 0, "no endpoint while speech continues");
    nowRef.t += 500;
    assert.equal(controller.finishTurnOnce(1, "max_recording", nowRef.t), true);
    assert.equal(finishes.length, 1);
    assert.equal(finishes[0]!.reason, "max_recording");
    assert.equal(controller.finishTurnOnce(1, "max_recording", nowRef.t), false, "duplicate blocked");
    assert.equal(finishes.length, 1);
  });

  it("duplicate frame callbacks / duplicate completions submit only once", () => {
    const { finishes, controller, nowRef } = simulate({ ambient: 0.025, peak: 0.1, postRms: 0.025, speechMs: 1000 });
    assert.equal(finishes.length, 1);
    // Stale frames after finish are rejected.
    controller.handleAudioFrame(1, 0.3, nowRef.t + 100);
    assert.equal(finishes.length, 1);
    // Duplicate completion blocked (finish_turn_ignored).
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

    // Current turn still endpoints normally.
    const threshold = computeSpeechThreshold(0.025);
    let runFrames = 0;
    let confirmed = false;
    for (let t = 0; t <= 4000 && currentFinishes.length === 0; t += FRAME_MS) {
      const now = 1000 + t;
      const rms = t < 400 ? 0.025 : t < 1400 ? 0.1 : 0.025;
      if (rms >= threshold) {
        runFrames += 1;
        if (runFrames >= SPEECH_FRAMES_TO_CONFIRM && !confirmed) {
          confirmed = true;
          current.noteSpeechConfirmed(now);
        }
      } else runFrames = 0;
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
    syncObserved = finishes.length === 1; // true before any microtask/await boundary
    assert.equal(syncObserved, true, "state flip happens synchronously (listening→thinking)");
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

describe("delta_weak fallback", () => {
  it("quiet speech below threshold but above 1.5x ambient triggers delta_weak", () => {
    const ambient = 0.004;
    const threshold = 0.012;
    const rmsMax = 0.009;
    assert.equal(shouldDeltaWeakTrigger(ambient, rmsMax, threshold), true);
    assert.equal(
      resolveNoSpeechOutcome({
        heardSpeech: false,
        elapsedMs: NO_SPEECH_MS,
        noSpeechMs: NO_SPEECH_MS,
        ambientRms: ambient,
        rmsMax,
        threshold,
      }),
      "delta_weak",
    );
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
