/// <reference types="node" />
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAX_TTS_PARTS } from "./playback";

describe("TTS part budget", () => {
  it("caps runaway multi-part replies", () => {
    assert.ok(MAX_TTS_PARTS >= 8);
    assert.ok(MAX_TTS_PARTS <= 32);
  });
});
