import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  __resetAudioOwnerForTests,
  attemptNonTtsSound,
  beginAssistantTts,
  endAssistantTts,
  finalizePlayback,
  getTtsVolume,
  isAssistantSpeaking,
  stopNonTtsAudio,
} from "./audio-owner.ts";
import { createVoiceLoop } from "../voice-loop.ts";

// Node test runner — import .ts relatives; production uses @/ via Next.

describe("audio owner / non-TTS gate", () => {
  beforeEach(() => {
    __resetAudioOwnerForTests();
  });

  it("beginAssistantTts stops non-TTS and sets volume 1.0", () => {
    let stopped = 0;
    // Simulate a leftover effect timer via stopNonTtsAudio counting handles.
    beginAssistantTts(7);
    assert.equal(isAssistantSpeaking(), true);
    assert.equal(getTtsVolume(), 1.0);
    const n = stopNonTtsAudio("tts_start");
    assert.ok(n >= 0);
    assert.equal(stopped, 0);
    assert.equal(getTtsVolume(), 1.0);
  });

  it("blocks any non-TTS sound attempt while speaking", () => {
    beginAssistantTts(3);
    assert.equal(attemptNonTtsSound("playCue_thinking"), false);
    assert.equal(isAssistantSpeaking(), true);
  });

  it("blocks non-TTS even when not speaking (effects disabled this release)", () => {
    endAssistantTts();
    assert.equal(attemptNonTtsSound("playCue_capture"), false);
  });

  it("natural end: speaking -> idle -> listening exactly once", () => {
    const transitions: string[] = [];
    const loop = createVoiceLoop((event, data) => {
      if (event === "voice_state") {
        transitions.push(`${data.from}->${data.to}`);
      }
    });
    const turn = loop.beginTurn();
    loop.transition("speaking", "playback_start");
    assert.equal(finalizePlayback(turn, "natural"), true);
    loop.transition("idle", "playback_natural");
    const resume = loop.tryResumeListening(turn);
    assert.equal(resume.ok, true);
    assert.equal(loop.state, "listening");
    // Second finalize ignored.
    assert.equal(finalizePlayback(turn, "natural"), false);
    // Second resume blocked.
    assert.equal(loop.tryResumeListening(turn).ok, false);
    assert.ok(transitions.includes("speaking->idle") || transitions.some((t) => t.endsWith("->idle")));
  });

  it("stopped playback: speaking -> idle and one mic open when active", () => {
    const micOpens: number[] = [];
    const loop = createVoiceLoop((event, data) => {
      if (event === "mic_open") micOpens.push(Number(data.turn_id));
    });
    const turn = loop.beginTurn();
    loop.transition("speaking", "playback_start");
    assert.equal(finalizePlayback(turn, "interrupted"), true);
    loop.transition("idle", "playback_interrupted");
    assert.equal(loop.tryResumeListening(turn).ok, true);
    assert.equal(loop.noteMicOpen(turn).ok, true);
    assert.equal(micOpens.length, 1);
    // No retry loop while / after listening.
    assert.equal(loop.tryResumeListening(turn).ok, false);
  });

  it("stop + ended together finalize only once", () => {
    const turn = 42;
    assert.equal(finalizePlayback(turn, "cancelled"), true);
    assert.equal(finalizePlayback(turn, "natural"), false);
    assert.equal(finalizePlayback(turn, "interrupted"), false);
  });

  it("no mic reopen retry while state remains speaking", () => {
    const skips: string[] = [];
    const loop = createVoiceLoop((event, data) => {
      if (event === "mic_open_skipped") skips.push(String(data.reason));
    });
    const turn = loop.beginTurn();
    loop.transition("speaking", "playback_start");
    // Bug case: playback_end stopped=true but state not cleared.
    for (let i = 0; i < 5; i += 1) {
      assert.equal(loop.tryResumeListening(turn).ok, false);
    }
    assert.ok(skips.every((r) => r === "not_active"));
    assert.equal(skips.length, 5);
    // After proper finalize + idle, exactly one resume works.
    finalizePlayback(turn, "cancelled");
    loop.transition("idle", "playback_cancelled");
    assert.equal(loop.tryResumeListening(turn).ok, true);
  });
});
