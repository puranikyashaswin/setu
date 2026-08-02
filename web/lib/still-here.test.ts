/// <reference types="node" />
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { STILL_HERE_AFTER_MS, shouldPromptStillHere, stillHerePhrase } from "./still-here";

describe("still-here prompt", () => {
  it("waits for idle threshold while listening", () => {
    assert.equal(
      shouldPromptStillHere({ listening: true, idleMs: STILL_HERE_AFTER_MS - 1, alreadyPrompted: false }).prompt,
      false,
    );
    assert.equal(
      shouldPromptStillHere({ listening: true, idleMs: STILL_HERE_AFTER_MS, alreadyPrompted: false }).prompt,
      true,
    );
  });

  it("does not repeat after already prompted", () => {
    assert.equal(
      shouldPromptStillHere({ listening: true, idleMs: 60_000, alreadyPrompted: true }).prompt,
      false,
    );
  });

  it("localizes phrase", () => {
    assert.match(stillHerePhrase("hi-IN"), /यहाँ/);
    assert.match(stillHerePhrase("en"), /still here/i);
  });
});
