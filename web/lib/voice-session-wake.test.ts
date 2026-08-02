import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  API_WAKE_TIMEOUT_MS,
  WS_CONNECT_TIMEOUT_MS,
  wakeApiForVoice,
} from "./voice-session";

describe("voice WebSocket cold-start hardening", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("uses a Render-friendly connect timeout (>=20s)", () => {
    assert.ok(WS_CONNECT_TIMEOUT_MS >= 20000, `got ${WS_CONNECT_TIMEOUT_MS}`);
    assert.ok(API_WAKE_TIMEOUT_MS >= 15000, `got ${API_WAKE_TIMEOUT_MS}`);
  });

  it("wakeApiForVoice hits /health with no-store", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }) as typeof fetch;

    const result = await wakeApiForVoice("https://setu-api.onrender.com", 5000);
    assert.equal(result.ok, true);
    assert.ok(result.ms >= 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://setu-api.onrender.com/health");
    assert.equal(calls[0]!.init?.cache, "no-store");
  });

  it("wakeApiForVoice returns ok=false on network failure", async () => {
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    const result = await wakeApiForVoice("https://example.invalid", 100);
    assert.equal(result.ok, false);
  });
});
