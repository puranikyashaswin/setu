import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { VadLevelTelemetry } from "./vad-levels";
import { trimUtteranceSilence, TRIM_PADDING_MS } from "./trim-silence";
import {
  computeSilenceFloor,
  computeSpeechThreshold,
  isSilenceRelativeToPeak,
  resolveNoSpeechOutcome,
  shouldDeltaWeakTrigger,
} from "./vad-threshold";
import { MIN_RECORDING_MS, NO_SPEECH_MS, SILENCE_MS } from "./recorder";

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

describe("peak-relative silence endpointing", () => {
  it("ambient 0.02 after speech peak 0.13 qualifies as silence (not 15s max_recording)", () => {
    const peakRms = 0.13;
    const ambient = 0.02;
    const silenceFloor = computeSilenceFloor(peakRms);
    assert.equal(silenceFloor, 0.0325);
    assert.equal(isSilenceRelativeToPeak(ambient, peakRms), true);
    assert.equal(SILENCE_MS, 700);
  });

  it("quiet speech peak 0.03 uses floor max(0.006, 0.0075) = 0.0075", () => {
    const peakRms = 0.03;
    const silenceFloor = computeSilenceFloor(peakRms);
    assert.equal(silenceFloor, 0.0075);
    assert.equal(isSilenceRelativeToPeak(0.007, peakRms), true);
    assert.equal(isSilenceRelativeToPeak(0.008, peakRms), false);
  });

  it("never uses speech-start threshold for silence-end", () => {
    const ambient = 0.02;
    const speechThreshold = computeSpeechThreshold(ambient);
    const peakRms = 0.13;
    const silenceFloor = computeSilenceFloor(peakRms);
    assert.ok(ambient < speechThreshold, "ambient stays below speech-start threshold");
    assert.ok(ambient < silenceFloor, "ambient also below peak-relative silence floor");
    assert.notEqual(silenceFloor, speechThreshold);
  });

  it("simulated frame sequence ends after ~700ms of post-speech ambient", () => {
    const peakRms = 0.13;
    const ambient = 0.02;
    const frameMs = 2.67;
    let silentSince: number | null = null;
    let ended = false;
    let endMs = 0;
    const startMs = 1000;

    for (let t = 0; t <= 16000; t += frameMs) {
      const now = startMs + t;
      const elapsed = t;
      const rms = t < 1200 ? 0.13 : ambient;
      if (t < 350) continue; // ambient calibration
      if (t >= 350 && t < 1200) continue; // speech phase

      if (isSilenceRelativeToPeak(rms, peakRms)) {
        if (silentSince == null) silentSince = now;
        const silentFor = now - silentSince;
        if (silentFor >= SILENCE_MS && elapsed >= MIN_RECORDING_MS) {
          ended = true;
          endMs = t;
          break;
        }
      } else {
        silentSince = null;
      }
    }

    assert.equal(ended, true);
    assert.ok(endMs >= 1200 + SILENCE_MS - frameMs * 2, `expected ~${1200 + SILENCE_MS}ms, got ${endMs}`);
    assert.ok(endMs < 15000, `should not hit 15s cap, got ${endMs}ms`);
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
