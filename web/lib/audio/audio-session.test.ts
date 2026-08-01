import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  IOS_TTS_SETTLE_MS,
  isIosPlatform,
  micOpenBlockReason,
  prepareAssistantPlayback,
  setAudioSession,
  settleBeforeTtsPlayback,
} from "./audio-session.ts";

type FakeSession = { type?: string };

describe("audio-session helper", () => {
  const originalNavigator = globalThis.navigator;
  let fakeSession: FakeSession | null;

  beforeEach(() => {
    fakeSession = { type: "auto" };
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
        audioSession: fakeSession,
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: originalNavigator,
    });
  });

  it("sets play-and-record and playback when audioSession exists", () => {
    assert.equal(setAudioSession("play-and-record"), true);
    assert.equal(fakeSession?.type, "play-and-record");
    assert.equal(setAudioSession("playback"), true);
    assert.equal(fakeSession?.type, "playback");
  });

  it("unsupported audioSession does not throw", () => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { userAgent: "Mozilla/5.0 (Linux; Android 14)" },
    });
    assert.doesNotThrow(() => {
      assert.equal(setAudioSession("playback"), false);
      assert.equal(setAudioSession("play-and-record"), false);
      assert.equal(setAudioSession("auto"), false);
    });
  });

  it("iOS settle delay is 150ms; non-iOS is 0", async () => {
    const iosMs = await settleBeforeTtsPlayback(true);
    assert.equal(iosMs, IOS_TTS_SETTLE_MS);
    const otherMs = await settleBeforeTtsPlayback(false);
    assert.equal(otherMs, 0);
  });

  it("isIosPlatform detects iPhone UA", () => {
    assert.equal(isIosPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)"), true);
    assert.equal(isIosPlatform("Mozilla/5.0 (Linux; Android 14)"), false);
    assert.equal(isIosPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)"), false);
  });

  it("prepareAssistantPlayback runs teardown before playback session + iOS delay", async () => {
    const order: string[] = [];
    fakeSession!.type = "play-and-record";
    const started = Date.now();
    await prepareAssistantPlayback({
      afterTeardown: async () => {
        order.push("teardown");
        assert.equal(fakeSession?.type, "play-and-record");
      },
      platformIsIos: true,
    });
    const elapsed = Date.now() - started;
    order.push(`session:${fakeSession?.type}`);
    assert.deepEqual(order, ["teardown", "session:playback"]);
    assert.ok(elapsed >= IOS_TTS_SETTLE_MS - 20, `expected ~${IOS_TTS_SETTLE_MS}ms settle, got ${elapsed}`);
  });

  it("non-iOS prepareAssistantPlayback has no settle delay", async () => {
    const started = Date.now();
    const { settleMs } = await prepareAssistantPlayback({
      afterTeardown: async () => undefined,
      platformIsIos: false,
    });
    const elapsed = Date.now() - started;
    assert.equal(settleMs, 0);
    assert.ok(elapsed < 80, `non-iOS must not wait 150ms, elapsed=${elapsed}`);
    assert.equal(fakeSession?.type, "playback");
  });

  it("mic cannot open while thinking/speaking/tts_active", () => {
    assert.equal(micOpenBlockReason({ voiceState: "thinking", ttsActive: false }), "thinking");
    assert.equal(micOpenBlockReason({ voiceState: "speaking", ttsActive: false }), "speaking");
    assert.equal(micOpenBlockReason({ voiceState: "idle", ttsActive: true }), "tts_active");
    assert.equal(micOpenBlockReason({ voiceState: "listening", ttsActive: false }), null);
    assert.equal(micOpenBlockReason({ voiceState: "idle", ttsActive: false }), null);
  });
});

describe("iOS mic/TTS session order", () => {
  it("play-and-record before mic open; playback before TTS", async () => {
    const session: FakeSession = { type: "auto" };
    const order: string[] = [];
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
        audioSession: session,
        mediaDevices: {
          getUserMedia: async () => {
            order.push(`getUserMedia:${session.type}`);
            return { getTracks: () => [] };
          },
        },
      },
    });

    // Production order: session → getUserMedia → (capture) → teardown → playback → settle → TTS.
    setAudioSession("play-and-record");
    order.push(`armed:${session.type}`);
    await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
    await prepareAssistantPlayback({
      afterTeardown: async () => {
        order.push("recorder_teardown");
      },
      platformIsIos: true,
    });
    order.push(`ready_tts:${session.type}`);

    assert.deepEqual(order, [
      "armed:play-and-record",
      "getUserMedia:play-and-record",
      "recorder_teardown",
      "ready_tts:playback",
    ]);
  });
});
