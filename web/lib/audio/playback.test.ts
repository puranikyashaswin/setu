import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  __resetPlaybackForTests,
  createPreparingWatchdog,
  PREPARING_WATCHDOG_MS,
  playDecodedBuffersSequential,
  stopAllPlayback,
  TTS_ROUTE,
  ttsUsesWebAudioGraph,
} from "./playback.ts";
import { __resetAudioOwnerForTests, isAssistantSpeaking } from "./audio-owner.ts";
import { createVoiceLoop } from "../voice-loop.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("html_audio TTS route", () => {
  const originalURL = globalThis.URL;
  const originalRAF = globalThis.requestAnimationFrame;
  const originalCAF = globalThis.cancelAnimationFrame;

  beforeEach(() => {
    __resetPlaybackForTests();
    __resetAudioOwnerForTests();
    (globalThis as unknown as { URL: unknown }).URL = class extends originalURL {
      static createObjectURL() {
        return "blob:test";
      }
      static revokeObjectURL() {}
    };
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) =>
      globalThis.setTimeout(() => cb(performance.now()), 0) as unknown as number;
    globalThis.cancelAnimationFrame = (id: number) => globalThis.clearTimeout(id);
  });

  afterEach(() => {
    stopAllPlayback("cancelled");
    __resetPlaybackForTests();
    (globalThis as unknown as { URL: unknown }).URL = originalURL;
    globalThis.requestAnimationFrame = originalRAF;
    globalThis.cancelAnimationFrame = originalCAF;
  });

  it("never uses AudioBufferSourceNode / shared context / GainNode for TTS", () => {
    assert.equal(ttsUsesWebAudioGraph(), false);
    assert.equal(TTS_ROUTE, "html_audio");
    const src = readFileSync(join(webRoot, "lib/audio/playback.ts"), "utf8");
    assert.equal(src.includes("createBufferSource"), false);
    assert.equal(src.includes("createGain"), false);
    assert.equal(src.includes("decodeAudioData"), false);
    assert.equal(src.includes("shared_context"), false);
    assert.ok(src.includes("HTMLAudioElement") || src.includes("new Audio"));
    assert.ok(src.includes("tts_route=html_audio") || src.includes('TTS_ROUTE = "html_audio"'));
  });

  it("play() failure finalizes outcome=error and leaves speaking state", async () => {
    const outcomes: string[] = [];
    const OriginalAudio = globalThis.Audio;
    (globalThis as unknown as { Audio: unknown }).Audio = class {
      volume = 1;
      src = "";
      currentTime = 0;
      preload = "";
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      play() {
        return Promise.reject(new Error("NotAllowedError"));
      }
      pause() {}
      load() {}
      removeAttribute() {}
    };

    try {
      const loop = createVoiceLoop();
      const turn = loop.beginTurn();
      loop.transition("thinking", "prepare_tts");
      await new Promise<void>((resolve) => {
        void playDecodedBuffersSequential({
          arrayBuffers: [new ArrayBuffer(8)],
          turnId: turn,
          onPlay: () => loop.transition("speaking", "playback_start"),
          onSettled: (outcome) => {
            outcomes.push(outcome);
            loop.transition("idle", `playback_${outcome}`);
            resolve();
          },
        });
      });
      assert.deepEqual(outcomes, ["error"]);
      assert.equal(loop.state, "idle");
      assert.equal(isAssistantSpeaking(), false);
    } finally {
      (globalThis as unknown as { Audio: unknown }).Audio = OriginalAudio;
    }
  });

  it("watchdog exits preparing if playback_start does not happen", async () => {
    const events: string[] = [];
    await new Promise<void>((resolve) => {
      const watchdog = createPreparingWatchdog({
        turnId: 42,
        ms: 30,
        onTimeout: () => {
          events.push("timeout");
          resolve();
        },
      });
      assert.ok(PREPARING_WATCHDOG_MS >= 8000);
      // Never call clear / playback_start — timeout must fire.
      void watchdog;
    });
    assert.deepEqual(events, ["timeout"]);
  });

  it("watchdog clear prevents false timeout after playback_start", async () => {
    let fired = false;
    const watchdog = createPreparingWatchdog({
      turnId: 1,
      ms: 40,
      onTimeout: () => {
        fired = true;
      },
    });
    watchdog.clear();
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(fired, false);
  });
});

describe("mic VAD pause while HTMLAudio plays", () => {
  it("stopRecorderTurn keeps stream so HTMLAudio can play with no TTS Web Audio graph", () => {
    const recorderSrc = readFileSync(join(webRoot, "lib/audio/recorder.ts"), "utf8");
    assert.ok(recorderSrc.includes("keep_stream"));
    assert.ok(recorderSrc.includes("releaseStream"));
    const playbackSrc = readFileSync(join(webRoot, "lib/audio/playback.ts"), "utf8");
    assert.equal(playbackSrc.includes("createBufferSource"), false);
    assert.equal(playbackSrc.includes("createGain"), false);
    assert.equal(playbackSrc.includes("decodeAudioData"), false);
    assert.ok(playbackSrc.includes("new Audio") || playbackSrc.includes("HTMLAudioElement"));
    const pageSrc = readFileSync(join(webRoot, "app/page.tsx"), "utf8");
    assert.ok(pageSrc.includes("prepareAssistantPlayback"));
    assert.ok(pageSrc.includes("stopActiveRecording(\"prepare_tts\")") || pageSrc.includes('stopActiveRecording("prepare_tts")'));
  });
});
