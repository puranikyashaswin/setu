/// <reference types="node" />
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { HAPTIC_PATTERNS, canVibrate, vibratePattern } from "./haptics";

describe("haptics", () => {
  const original = globalThis.navigator;

  beforeEach(() => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { vibrate: () => true },
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: original,
    });
  });

  it("defines pass/warn/fail patterns", () => {
    assert.ok(HAPTIC_PATTERNS.pass.length >= 3);
    assert.ok(HAPTIC_PATTERNS.fail.length >= 3);
    assert.ok(HAPTIC_PATTERNS.warn.length >= 2);
  });

  it("vibratePattern returns true when vibrate is available", () => {
    assert.equal(canVibrate(), true);
    assert.equal(vibratePattern(HAPTIC_PATTERNS.pass), true);
  });

  it("vibratePattern returns false when vibrate missing", () => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {},
    });
    assert.equal(canVibrate(), false);
    assert.equal(vibratePattern([10]), false);
  });
});
