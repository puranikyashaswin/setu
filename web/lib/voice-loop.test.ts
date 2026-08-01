import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createVoiceLoop } from "./voice-loop.ts";
import { playPartsSerially, createPlaybackQueue } from "./audio/playback-queue.ts";

describe("voice-loop single-flight", () => {
  it("three rapid resumeListening create one mic claim only", () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const loop = createVoiceLoop((event, data) => events.push({ event, data }));
    const turn = loop.beginTurn();
    loop.transition("idle", "playback_end");

    const a = loop.tryResumeListening(turn);
    const b = loop.tryResumeListening(turn);
    const c = loop.tryResumeListening(turn);

    assert.equal(a.ok, true);
    assert.equal(b.ok, false);
    assert.equal(c.ok, false);
    if (!b.ok) assert.equal(b.reason, "already_listening");
    if (!c.ok) assert.equal(c.reason, "already_listening");

    const micOpens = events.filter((e) => e.event === "mic_open");
    // mic_open is logged from noteMicOpen, not tryResume — only one listening claim.
    assert.equal(loop.state, "listening");
    const skips = events.filter((e) => e.event === "mic_open_skipped");
    assert.equal(skips.length, 2);

    const open = loop.noteMicOpen(turn);
    assert.equal(open.ok, true);
    assert.equal(events.filter((e) => e.event === "mic_open").length, 1);
  });

  it("stale playback_end cannot reopen the mic", () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const loop = createVoiceLoop((event, data) => events.push({ event, data }));
    const turn1 = loop.beginTurn();
    loop.transition("idle", "playback_end");
    const turn2 = loop.beginTurn(); // newer speak started
    const stale = loop.tryResumeListening(turn1);
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.reason, "stale_turn");
    assert.equal(loop.state, "idle");
    // Current turn can still resume.
    const fresh = loop.tryResumeListening(turn2);
    assert.equal(fresh.ok, true);
  });

  it("blocks resume while speaking/thinking/scanning/stopped", () => {
    const loop = createVoiceLoop();
    const turn = loop.beginTurn();
    for (const state of ["speaking", "thinking", "scanning", "stopped"] as const) {
      loop.transition(state, "test");
      const gate = loop.tryResumeListening(turn);
      assert.equal(gate.ok, false);
      if (!gate.ok) assert.equal(gate.reason, "not_active");
    }
  });

  it("auto-relisten only after idle (post playback_finalize)", () => {
    const loop = createVoiceLoop();
    const turn = loop.beginTurn();
    loop.transition("speaking", "playback_start");
    assert.equal(loop.tryResumeListening(turn).ok, false);
    loop.transition("idle", "playback_natural");
    assert.equal(loop.tryResumeListening(turn).ok, true);
  });
});

describe("playback queue serial parts", () => {
  it("two queued parts play strictly serially", () => {
    const events = playPartsSerially(2);
    const starts = events.filter((e) => e.type === "start");
    const ends = events.filter((e) => e.type === "end");
    assert.equal(starts.length, 2);
    assert.equal(ends.length, 2);
    assert.equal(starts[0]?.part, 1);
    assert.equal(ends[0]?.part, 1);
    assert.equal(starts[1]?.part, 2);
    // Part 2 start is after part 1 end in the log order.
    const end1Idx = events.findIndex((e) => e.type === "end" && e.part === 1);
    const start2Idx = events.findIndex((e) => e.type === "start" && e.part === 2);
    assert.ok(end1Idx < start2Idx);
  });

  it("cannot begin part 2 while part 1 active", () => {
    const q = createPlaybackQueue(2);
    assert.equal(q.beginPart(1), true);
    assert.equal(q.beginPart(2), false);
    q.endPart(true);
    assert.equal(q.beginPart(2), true);
  });
});
