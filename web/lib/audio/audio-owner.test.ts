import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  __resetAudioOwnerForTests,
  beginAssistantTts,
  finalizePlayback,
  getTtsVolume,
  isAssistantSpeaking,
  stopNonTtsAudio,
} from "./audio-owner.ts";
import { createVoiceLoop } from "../voice-loop.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("cue code removed from page.tsx", () => {
  it("contains no playCue / attemptNonTtsSound / oscillator cue interval", () => {
    const src = readFileSync(join(webRoot, "app/page.tsx"), "utf8");
    assert.equal(src.includes("playCue"), false, "playCue must be deleted");
    assert.equal(src.includes("attemptNonTtsSound"), false, "attemptNonTtsSound must be deleted");
    assert.equal(src.includes("createOscillator"), false);
    assert.equal(src.includes("createBuffer"), false, "cue noise buffers must be gone");
    assert.equal(src.includes("playCue_muted"), false);
    assert.equal(src.includes("soundOn"), false);
    // Thinking interval may remain for UI labels only — must not touch AudioContext.
    const thinkingBlock = src.match(
      /Visual thinking stages[\s\S]*?}, \[activeService, orbState\]\);/,
    );
    assert.ok(thinkingBlock, "thinking visual effect should remain");
    assert.equal(thinkingBlock![0].includes("AudioContext"), false);
    assert.equal(thinkingBlock![0].includes("getAudioContext"), false);
    assert.equal(thinkingBlock![0].includes("resume"), false);
    assert.equal(thinkingBlock![0].includes("playCue"), false);
  });

  it("audio-owner has no public attemptNonTtsSound API", () => {
    const src = readFileSync(join(webRoot, "lib/audio/audio-owner.ts"), "utf8");
    assert.equal(src.includes("attemptNonTtsSound"), false);
    assert.equal(src.includes("unexpected_non_tts_attempt"), false);
    assert.equal(src.includes("registerNonTtsEffect"), false);
  });
});

describe("audio owner", () => {
  beforeEach(() => {
    __resetAudioOwnerForTests();
  });

  it("beginAssistantTts sets volume 1.0 and stopNonTtsAudio is harmless", () => {
    beginAssistantTts(7);
    assert.equal(isAssistantSpeaking(), true);
    assert.equal(getTtsVolume(), 1.0);
    assert.equal(stopNonTtsAudio("tts_start"), 0);
  });

  it("natural end: speaking -> idle -> listening exactly once", () => {
    const loop = createVoiceLoop();
    const turn = loop.beginTurn();
    loop.transition("speaking", "playback_start");
    assert.equal(finalizePlayback(turn, "natural"), true);
    loop.transition("idle", "playback_natural");
    assert.equal(loop.tryResumeListening(turn).ok, true);
    assert.equal(finalizePlayback(turn, "natural"), false);
    assert.equal(loop.tryResumeListening(turn).ok, false);
  });

  it("stopped playback finalizes once; no mic retry while speaking", () => {
    const loop = createVoiceLoop();
    const turn = loop.beginTurn();
    loop.transition("speaking", "playback_start");
    for (let i = 0; i < 3; i += 1) {
      assert.equal(loop.tryResumeListening(turn).ok, false);
    }
    assert.equal(finalizePlayback(turn, "interrupted"), true);
    assert.equal(finalizePlayback(turn, "natural"), false);
    loop.transition("idle", "playback_interrupted");
    assert.equal(loop.tryResumeListening(turn).ok, true);
  });
});
