/// <reference types="node" />
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CLOSE_TALK_ABSOLUTE,
  CLOSE_TALK_SNR,
  QUIET_AFTER_SPEECH_MS,
  SPEECH_PEAK_QUIET_RATIO,
} from "./endpoint";

describe("close-talk endpoint constants", () => {
  it("keeps close-talk SNR above far-talk room chatter", () => {
    assert.ok(CLOSE_TALK_SNR >= 4);
    assert.ok(CLOSE_TALK_ABSOLUTE >= 0.02);
  });

  it("ends turns after about a second of quiet relative to peak", () => {
    assert.ok(QUIET_AFTER_SPEECH_MS >= 800);
    assert.ok(SPEECH_PEAK_QUIET_RATIO < 0.4);
  });
});
