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
  ENDPOINT_MIN_AFTER_SPEECH_MS,
  ENDPOINT_POST_SPEECH_FALLBACK_MS,
  ENDPOINT_SILENCE_MS,
  EndpointDetector,
  computeEndpointSilenceFloor,
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

describe("adaptive endpoint detection", () => {
  const FRAME_MS = 2.67;
  const CALIBRATION_MS = 400;

  type SimOptions = {
    ambient: number;
    peak: number;
    postRms: number;
    speechMs?: number;
    /** Optional mid-speech dip: [startOffsetMs, durationMs] at ambient level. */
    dip?: [number, number];
    /** Optional post-speech noise spike: [startOffsetMs, durationMs, rms]. */
    spike?: [number, number, number];
  };

  function simulate(opts: SimOptions) {
    const speechMs = opts.speechMs ?? 1500;
    const threshold = computeSpeechThreshold(opts.ambient);
    const detector = new EndpointDetector({ ambientBaseline: opts.ambient });
    const t0 = 1000;
    const speechStart = CALIBRATION_MS;
    const speechEnd = speechStart + speechMs;
    let runFrames = 0;
    let confirmed = false;
    let decision: ReturnType<EndpointDetector["onFrame"]> = null;
    let decisionT = 0;
    let earlyDecisionT: number | null = null;

    for (let t = 0; t <= 20000; t += FRAME_MS) {
      const now = t0 + t;
      let rms: number;
      if (t < speechStart) {
        rms = opts.ambient;
      } else if (t < speechEnd) {
        const inDip = opts.dip && t - speechStart >= opts.dip[0] && t - speechStart < opts.dip[0] + opts.dip[1];
        rms = inDip ? opts.ambient : opts.peak;
      } else {
        const post = t - speechEnd;
        const inSpike = opts.spike && post >= opts.spike[0] && post < opts.spike[0] + opts.spike[1];
        rms = inSpike ? opts.spike[2] : opts.postRms;
      }

      if (rms >= threshold) {
        runFrames += 1;
        if (runFrames >= SPEECH_FRAMES_TO_CONFIRM && !confirmed) {
          confirmed = true;
          detector.noteSpeechConfirmed(now);
        }
      } else {
        runFrames = 0;
      }

      const d = detector.onFrame(rms, now, threshold);
      if (d && t < speechEnd) earlyDecisionT = t;
      if (d) {
        decision = d;
        decisionT = t;
        break;
      }
    }
    return { decision, decisionT, speechEnd, speechStart, confirmed, earlyDecisionT, detector, threshold };
  }

  it("ambient 0.025, peak 0.10, post 0.025 → primary endpoint ~850–1200ms after speech", () => {
    const { decision, decisionT, speechEnd } = simulate({ ambient: 0.025, peak: 0.1, postRms: 0.025 });
    assert.ok(decision, "expected an endpoint decision");
    assert.equal(decision.reason, "primary");
    const afterEnd = decisionT - speechEnd;
    assert.ok(afterEnd >= ENDPOINT_SILENCE_MS - 50, `too early: ${afterEnd}ms`);
    assert.ok(afterEnd <= 1400, `too late: ${afterEnd}ms`);
    assert.ok(decisionT < 15000, "must not reach max_recording");
  });

  it("ambient 0.025, quiet speech peak 0.060, post 0.025 → endpoints via primary or relative_drop", () => {
    const { decision, decisionT, speechEnd } = simulate({ ambient: 0.025, peak: 0.06, postRms: 0.025 });
    assert.ok(decision, "expected an endpoint decision");
    assert.ok(decision.reason === "primary" || decision.reason === "relative_drop");
    assert.ok(decisionT - speechEnd <= 1600, `too late: ${decisionT - speechEnd}ms`);
    assert.ok(decisionT < 15000);
  });

  it("loud room: ambient 0.040, peak 0.12 → still endpoints without max_recording", () => {
    const { decision, decisionT } = simulate({ ambient: 0.04, peak: 0.12, postRms: 0.04 });
    assert.ok(decision, "expected an endpoint decision");
    assert.notEqual(decision.reason, "post_speech_fallback");
    assert.ok(decisionT < 15000, "must not reach max_recording");
  });

  it("brief noise dip/spike does not prematurely endpoint during active speech", () => {
    const { decision, decisionT, speechEnd, earlyDecisionT } = simulate({
      ambient: 0.025,
      peak: 0.1,
      postRms: 0.025,
      speechMs: 2500,
      dip: [1000, 300],
      spike: [300, 150, 0.4],
    });
    assert.equal(earlyDecisionT, null, "must not endpoint during active speech");
    assert.ok(decision, "expected an endpoint decision");
    assert.ok(decisionT > speechEnd + 300 + 150, "spike must not be treated as utterance end");
  });

  it("never endpoints during the first 900ms after confirmed speech", () => {
    const { decision, decisionT, speechStart } = simulate({
      ambient: 0.025,
      peak: 0.1,
      postRms: 0.025,
      speechMs: 200,
    });
    assert.ok(decision, "expected an endpoint decision");
    const confirmedAt = speechStart + SPEECH_FRAMES_TO_CONFIRM * FRAME_MS;
    assert.ok(
      decisionT >= confirmedAt + ENDPOINT_MIN_AFTER_SPEECH_MS - FRAME_MS * 2,
      `endpoint at ${decisionT} before min window (${confirmedAt}+${ENDPOINT_MIN_AFTER_SPEECH_MS})`,
    );
  });

  it("confirmed speech with no endpoint triggers post_speech_fallback 4.5s after latest peak", () => {
    // Post-speech noise 0.036 sits above both the silence floor (0.0313) and the
    // relative-drop ceiling (0.035) but below the speech-start threshold (0.045).
    const { decision, decisionT, speechEnd } = simulate({
      ambient: 0.025,
      peak: 0.1,
      postRms: 0.036,
      speechMs: 1200,
    });
    assert.ok(decision, "expected an endpoint decision");
    assert.equal(decision.reason, "post_speech_fallback");
    const afterEnd = decisionT - speechEnd;
    assert.ok(Math.abs(afterEnd - ENDPOINT_POST_SPEECH_FALLBACK_MS) < 200, `fallback at ${afterEnd}ms after speech end`);
    assert.ok(decisionT < 15000);
  });

  it("silence floor clamps to [0.006, 0.060] and never uses speech-start threshold", () => {
    assert.equal(computeEndpointSilenceFloor(0.001, 0.01), 0.006);
    assert.equal(computeEndpointSilenceFloor(0.5, 0.9), 0.06);
    const floor = computeEndpointSilenceFloor(0.025, 0.1);
    assert.notEqual(floor, computeSpeechThreshold(0.025));
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
