import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { VadLevelTelemetry } from "./vad-levels";
import {
  computeSpeechThreshold,
  resolveNoSpeechOutcome,
  shouldDeltaWeakTrigger,
} from "./vad-threshold";
import { NO_SPEECH_MS } from "./recorder";

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
