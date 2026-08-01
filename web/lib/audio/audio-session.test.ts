import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
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

  it("sets play-and-record when audioSession exists", () => {
    assert.equal(setAudioSession("play-and-record"), true);
    assert.equal(fakeSession?.type, "play-and-record");
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

  it("sticky shared-context path does not apply iOS settle delay", async () => {
    fakeSession!.type = "play-and-record";
    const started = Date.now();
    const { settleMs } = await prepareAssistantPlayback({
      afterTeardown: async () => undefined,
      platformIsIos: true,
    });
    const elapsed = Date.now() - started;
    assert.equal(settleMs, 0);
    assert.ok(elapsed < 80, `must not wait 150ms, elapsed=${elapsed}`);
    // Must not flip away from play-and-record between turns.
    assert.equal(fakeSession?.type, "play-and-record");
    assert.equal(await settleBeforeTtsPlayback(true), 0);
  });

  it("isIosPlatform detects iPhone UA", () => {
    assert.equal(isIosPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)"), true);
    assert.equal(isIosPlatform("Mozilla/5.0 (Linux; Android 14)"), false);
  });

  it("mic cannot open while thinking/speaking/tts_active", () => {
    assert.equal(micOpenBlockReason({ voiceState: "thinking", ttsActive: false }), "thinking");
    assert.equal(micOpenBlockReason({ voiceState: "speaking", ttsActive: false }), "speaking");
    assert.equal(micOpenBlockReason({ voiceState: "idle", ttsActive: true }), "tts_active");
    assert.equal(micOpenBlockReason({ voiceState: "listening", ttsActive: false }), null);
  });
});
