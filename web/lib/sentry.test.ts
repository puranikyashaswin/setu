/// <reference types="node" />
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { initSentry, scrubEvent } from "./sentry";

describe("sentry scrubbing", () => {
  it("filters sensitive voice/document keys", () => {
    const out = scrubEvent({
      request: { transcript: "hello", route: "/voice" },
      extra: { message: "user said hi", count: 1 },
      contexts: { audio_base64: "AAAA" },
    });
    assert.equal(out.request?.transcript, "[Filtered]");
    assert.equal(out.request?.route, "/voice");
    assert.equal(out.extra?.message, "[Filtered]");
    assert.equal(out.extra?.count, 1);
    assert.equal(out.contexts?.audio_base64, "[Filtered]");
  });

  it("scrubs nested structures", () => {
    const out = scrubEvent({
      extra: { nested: { text: "secret", ok: true } },
    });
    const nested = out.extra?.nested as Record<string, unknown>;
    assert.equal(nested.text, "[Filtered]");
    assert.equal(nested.ok, true);
  });
});

describe("initSentry no-op", () => {
  it("returns without loading @sentry/nextjs when DSN is unset", async () => {
    const prev = process.env.NEXT_PUBLIC_SENTRY_DSN;
    delete process.env.NEXT_PUBLIC_SENTRY_DSN;
    try {
      await assert.doesNotReject(() => initSentry());
    } finally {
      if (prev === undefined) delete process.env.NEXT_PUBLIC_SENTRY_DSN;
      else process.env.NEXT_PUBLIC_SENTRY_DSN = prev;
    }
  });

  it("returns without loading @sentry/nextjs when DSN is blank", async () => {
    const prev = process.env.NEXT_PUBLIC_SENTRY_DSN;
    process.env.NEXT_PUBLIC_SENTRY_DSN = "   ";
    try {
      await assert.doesNotReject(() => initSentry());
    } finally {
      if (prev === undefined) delete process.env.NEXT_PUBLIC_SENTRY_DSN;
      else process.env.NEXT_PUBLIC_SENTRY_DSN = prev;
    }
  });
});
