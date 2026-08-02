/// <reference types="node" />
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MIC_CAMERA_CONSENT_PHRASE, consentPhraseForLanguage } from "./consent";

describe("consent phrases", () => {
  it("returns English default", () => {
    assert.equal(consentPhraseForLanguage("en"), MIC_CAMERA_CONSENT_PHRASE);
  });

  it("localizes Hindi", () => {
    assert.match(consentPhraseForLanguage("hi-IN"), /माइक्रोफ़ोन/);
  });
});
