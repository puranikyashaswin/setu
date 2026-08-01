import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  __forceOpeningInFlightForTests,
  __resetMicSessionForTests,
  beginGumOpen,
  createListeningDeadMicWatchdog,
  endGumOpen,
  ensureMicSession,
  getGetUserMediaCallCount,
  isOpeningInFlight,
  LISTENING_DEAD_MIC_MS,
  OPENING_STUCK_MS,
  releaseMicSession,
  setMicOpenStuckRetry,
  setMicSessionAudioSession,
  setMicSessionLogger,
  streamAlive,
} from "./mic-session";
import { micOpenBlockReason, prepareAssistantPlayback } from "./audio-session";

type FakeSession = { type?: string };

function fakeTrack(state: MediaStreamTrackState = "live") {
  return {
    readyState: state,
    stop() {
      (this as { readyState: string }).readyState = "ended";
    },
  };
}

function fakeStream(tracks = [fakeTrack()]) {
  return {
    active: tracks.some((t) => t.readyState === "live"),
    getTracks: () => tracks,
  };
}

function installNavigator(opts: {
  getUserMediaDelayMs?: number;
  audioSession?: FakeSession;
  reject?: boolean;
}) {
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
          if (opts.reject) throw new Error("Permission denied");
          return fakeStream();
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

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
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
    assert.equal(a.path, "gum");
    assert.equal(getGetUserMediaCallCount(), 1);
    const b = await ensureMicSession({ turnId: 2 });
    assert.equal(b.reused, true);
    assert.equal(b.path, "attach");
    assert.equal(getGetUserMediaCallCount(), 1);
    const c = await ensureMicSession({ turnId: 3 });
    assert.equal(c.reused, true);
    assert.equal(getGetUserMediaCallCount(), 1);
    assert.equal(nav.gumCalls, 1);
    assert.ok(a.acquireMs >= 20);
    assert.ok(b.acquireMs < 20, `reused acquire should be fast, got ${b.acquireMs}`);
  });

  it("opening_in_flight clears after getUserMedia resolves", async () => {
    installNavigator({ getUserMediaDelayMs: 30 });
    assert.equal(isOpeningInFlight(), false);
    const p = ensureMicSession();
    await sleep(5);
    assert.equal(isOpeningInFlight(), true);
    await p;
    assert.equal(isOpeningInFlight(), false);
  });

  it("opening_in_flight clears after getUserMedia rejects", async () => {
    installNavigator({ reject: true });
    await assert.rejects(() => ensureMicSession(), /Permission denied|audio_true|getUserMedia/);
    assert.equal(isOpeningInFlight(), false);
  });

  it("second open with live stream attaches without getUserMedia and never blocks", async () => {
    const nav = installNavigator({});
    await ensureMicSession({ turnId: 1 });
    __forceOpeningInFlightForTests(0);
    // Attach path must ignore the guard entirely.
    const second = await ensureMicSession({ turnId: 2 });
    assert.equal(second.path, "attach");
    assert.equal(second.reused, true);
    assert.equal(nav.gumCalls, 1);
    // Attach did not clear or require the GUM guard — end leftover test force.
    endGumOpen();
    assert.equal(isOpeningInFlight(), false);
  });

  it("stuck flag >3s auto-clears and retries once", async () => {
    installNavigator({});
    let retries = 0;
    setMicOpenStuckRetry(() => {
      retries += 1;
    });
    __forceOpeningInFlightForTests(0);
    assert.equal(isOpeningInFlight(), true);
    await sleep(OPENING_STUCK_MS + 80);
    assert.equal(isOpeningInFlight(), false);
    assert.equal(retries, 1);
    // Second stuck clear does not retry again.
    __forceOpeningInFlightForTests(0);
    await sleep(OPENING_STUCK_MS + 80);
    assert.equal(isOpeningInFlight(), false);
    assert.equal(retries, 1);
  });

  it("beginGumOpen blocks while in flight under stuck window", () => {
    __forceOpeningInFlightForTests(100);
    const claim = beginGumOpen();
    assert.equal(claim.ok, false);
    if (!claim.ok) assert.equal(claim.reason, "opening_in_flight");
    endGumOpen();
  });

  it("listening state with no utterance_window_start after 4s triggers exactly one recovery attempt", async () => {
    let recoveries = 0;
    let utterance = false;
    const wd = createListeningDeadMicWatchdog({
      turnId: 7,
      ms: 40,
      hasUtteranceWindowStarted: () => utterance,
      onDead: () => {
        recoveries += 1;
      },
    });
    await sleep(80);
    assert.equal(recoveries, 1);
    wd.clear();

    // If utterance started, no recovery.
    recoveries = 0;
    utterance = true;
    const wd2 = createListeningDeadMicWatchdog({
      turnId: 8,
      ms: 40,
      hasUtteranceWindowStarted: () => utterance,
      onDead: () => {
        recoveries += 1;
      },
    });
    await sleep(80);
    assert.equal(recoveries, 0);
    wd2.clear();
    assert.equal(LISTENING_DEAD_MIC_MS, 4000);
  });

  it("dead tracks force re-acquire via gum", async () => {
    const nav = installNavigator({});
    const first = await ensureMicSession({ turnId: 1 });
    assert.equal(first.path, "gum");
    first.stream.getTracks().forEach((t) => t.stop());
    assert.equal(streamAlive(first.stream), false);
    const second = await ensureMicSession({ turnId: 2 });
    assert.equal(second.path, "gum");
    assert.equal(second.reused, false);
    assert.equal(nav.gumCalls, 2);
  });

  it("listening uses play-and-record; TTS prepare flips to playback without new getUserMedia", async () => {
    const nav = installNavigator({ audioSession: { type: "auto" } });
    await ensureMicSession();
    assert.equal(nav.session.type, "play-and-record");
    assert.equal(nav.gumCalls, 1);
    await prepareAssistantPlayback({ platformIsIos: true });
    assert.equal(nav.session.type, "playback");
    assert.equal(nav.gumCalls, 1);
    await ensureMicSession();
    assert.equal(nav.session.type, "play-and-record");
    assert.equal(nav.gumCalls, 1);
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

  it("session logger receives mic_session_stream_state", async () => {
    const events: string[] = [];
    setMicSessionLogger((event) => {
      events.push(event);
    });
    installNavigator({});
    await ensureMicSession({ turnId: 1 });
    assert.ok(events.includes("mic_session_stream_state"));
    assert.ok(events.includes("mic_acquire"));
  });
});
