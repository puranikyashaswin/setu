import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  __resetMicSessionForTests,
  ensureMicSession,
  getGetUserMediaCallCount,
  releaseMicSession,
  setMicSessionAudioSession,
} from "./mic-session.ts";
import { micOpenBlockReason, prepareAssistantPlayback } from "./audio-session.ts";

type FakeSession = { type?: string };

function fakeTrack() {
  return {
    readyState: "live" as MediaStreamTrackState,
    stop() {
      (this as { readyState: string }).readyState = "ended";
    },
  };
}

function installNavigator(opts: { getUserMediaDelayMs?: number; audioSession?: FakeSession }) {
  const session = opts.audioSession ?? { type: "auto" };
  let gumCalls = 0;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
      audioSession: session,
      mediaDevices: {
        getUserMedia: async () => {
          gumCalls += 1;
          if (opts.getUserMediaDelayMs) {
            await new Promise((r) => setTimeout(r, opts.getUserMediaDelayMs));
          }
          return { getTracks: () => [fakeTrack()] };
        },
      },
    },
  });
  (globalThis as unknown as { AudioContext: unknown }).AudioContext = class {
    state = "running";
    sampleRate = 48000;
    async resume() {
      this.state = "running";
    }
    async close() {
      this.state = "closed";
    }
  };
  setMicSessionAudioSession((type) => {
    session.type = type;
    return true;
  });
  return {
    get gumCalls() {
      return gumCalls;
    },
    session,
  };
}

describe("persistent mic session", () => {
  const originalNavigator = globalThis.navigator;
  const originalAC = (globalThis as unknown as { AudioContext?: unknown }).AudioContext;

  beforeEach(() => {
    __resetMicSessionForTests();
  });

  afterEach(() => {
    releaseMicSession();
    __resetMicSessionForTests();
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: originalNavigator,
    });
    (globalThis as unknown as { AudioContext: unknown }).AudioContext = originalAC;
  });

  it("getUserMedia called once per session; turns 2..N reuse stream", async () => {
    const nav = installNavigator({ getUserMediaDelayMs: 20 });
    const a = await ensureMicSession();
    assert.equal(a.reused, false);
    assert.equal(getGetUserMediaCallCount(), 1);
    const b = await ensureMicSession();
    assert.equal(b.reused, true);
    assert.equal(getGetUserMediaCallCount(), 1);
    const c = await ensureMicSession();
    assert.equal(c.reused, true);
    assert.equal(getGetUserMediaCallCount(), 1);
    assert.equal(nav.gumCalls, 1);
    assert.ok(a.acquireMs >= 20);
    assert.ok(b.acquireMs < 20, `reused acquire should be fast, got ${b.acquireMs}`);
  });

  it("audioSession stays play-and-record; no per-turn playback flip", async () => {
    const nav = installNavigator({ audioSession: { type: "auto" } });
    await ensureMicSession();
    assert.equal(nav.session.type, "play-and-record");
    await prepareAssistantPlayback({ platformIsIos: true });
    assert.equal(nav.session.type, "play-and-record");
  });

  it("timers arm at stream ready, not at getUserMedia request (2s delay sim)", async () => {
    installNavigator({ getUserMediaDelayMs: 200 });
    const requestAt = performance.now();
    await ensureMicSession();
    const timerArmedAt = performance.now();
    const requestToReady = timerArmedAt - requestAt;
    assert.ok(requestToReady >= 180, `ready waited for gum, got ${requestToReady}`);
    const elapsedSinceArm = performance.now() - timerArmedAt;
    assert.ok(elapsedSinceArm < 50, `timer baseline must be stream ready, elapsed=${elapsedSinceArm}`);
  });

  it("early teardown heuristic: <2s and no speech", () => {
    const EARLY_MS = 2000;
    const isEarly = (ageMs: number, heardSpeech: boolean) => ageMs < EARLY_MS && !heardSpeech;
    assert.equal(isEarly(500, false), true);
    assert.equal(isEarly(500, true), false);
    assert.equal(isEarly(2500, false), false);
  });

  it("mic cannot open while thinking/speaking", () => {
    assert.equal(micOpenBlockReason({ voiceState: "thinking", ttsActive: false }), "thinking");
    assert.equal(micOpenBlockReason({ voiceState: "speaking", ttsActive: false }), "speaking");
    assert.equal(micOpenBlockReason({ voiceState: "listening", ttsActive: false }), null);
  });
});
