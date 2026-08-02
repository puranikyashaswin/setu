/// <reference types="node" />
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildVoiceWsUrl, wsBaseUrl } from "./voice-session";

describe("voice WebSocket URL builder", () => {
  it("maps https API to wss", () => {
    assert.equal(wsBaseUrl("https://api.example.com"), "wss://api.example.com");
  });

  it("includes signed token for production auth", () => {
    const url = buildVoiceWsUrl({
      userId: "u1",
      sessionId: "s1",
      token: "u1.sig",
      apiUrl: "https://api.example.com",
    });
    assert.match(url, /^wss:\/\/api\.example\.com\/ws\/voice\?/);
    assert.match(url, /user_id=u1/);
    assert.match(url, /token=u1\.sig/);
    assert.match(url, /session_id=s1/);
  });
});
