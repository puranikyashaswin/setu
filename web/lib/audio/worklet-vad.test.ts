import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getVadWorkletUrl, VAD_WORKLET_VERSION } from "./worklet-vad";

describe("AudioWorklet URL / CDN safety", () => {
  it("cache-busts vad-processor.js so Safari/CDN cannot pin a stale module", () => {
    const url = getVadWorkletUrl();
    assert.match(url, /^\/vad-processor\.js\?v=/);
    assert.ok(url.includes(`v=${VAD_WORKLET_VERSION}`));
  });

  it("service worker bypasses vad-processor and _next (no cache-first)", () => {
    const sw = readFileSync(join(process.cwd(), "public/sw.js"), "utf8");
    assert.match(sw, /setu-shell-v3/);
    assert.match(sw, /mustBypassCache/);
    assert.match(sw, /vad-processor\.js/);
    assert.match(sw, /_next\//);
    assert.match(sw, /cache:\s*["']no-store["']/);
    // Must not use cache-first as the default for same-origin GETs.
    assert.doesNotMatch(sw, /caches\.match\(request\)\.then\(\(cached\) => cached \|\| fetch/);
  });
});
