/// <reference types="node" />
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bannerForApiFailure, classifyApiFailure } from "./api-failure";

describe("api failure banners", () => {
  it("classifies rate limit and credits", () => {
    assert.equal(classifyApiFailure("Too many requests", 429), "rate_limit");
    assert.equal(classifyApiFailure("insufficient credits"), "credits");
    assert.equal(classifyApiFailure("Failed to fetch"), "network");
  });

  it("returns actionable banner copy", () => {
    assert.match(bannerForApiFailure("credits"), /credits/i);
    assert.match(bannerForApiFailure("network"), /network/i);
  });
});
