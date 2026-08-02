/// <reference types="node" />
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertProductionApiUrl, isHttpsApiUrl, isLocalApiUrl } from "./env";

describe("production API URL guard", () => {
  it("accepts https and localhost", () => {
    assert.equal(isHttpsApiUrl("https://setu-api.onrender.com"), true);
    assert.equal(isLocalApiUrl("http://localhost:8000"), true);
    assert.doesNotThrow(() => assertProductionApiUrl("https://api.example.com", "production"));
    assert.doesNotThrow(() => assertProductionApiUrl("http://localhost:8000", "production"));
  });

  it("rejects http API on production builds", () => {
    assert.throws(
      () => assertProductionApiUrl("http://setu-api.onrender.com", "production"),
      /https/i,
    );
  });

  it("skips checks outside production", () => {
    assert.doesNotThrow(() => assertProductionApiUrl("http://setu-api.onrender.com", "development"));
  });
});
