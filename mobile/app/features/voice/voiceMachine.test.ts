import assert from "node:assert/strict";
import test from "node:test";

import { initialVoiceSnapshot, reduceVoiceCommand, reduceVoiceEvent } from "./voiceMachine";

const base = { protocol: "voice.v1" as const, sessionId: "session-1", turnId: "turn-1" };

test("rejects stale audio from an interrupted turn", () => {
  let state = reduceVoiceCommand(initialVoiceSnapshot, { type: "session.connect" });
  state = reduceVoiceEvent(state, { ...base, type: "session.ready" });
  state = reduceVoiceCommand(state, { type: "turn.begin", turnId: "turn-1" });
  state = reduceVoiceCommand(state, { type: "barge_in", reason: "speech_detected" });
  const late = reduceVoiceEvent(state, { ...base, type: "assistant.audio.started" });
  assert.equal(late.state, "INTERRUPTED");
});

test("plays a completed answer back into listening", () => {
  let state = reduceVoiceCommand(initialVoiceSnapshot, { type: "session.connect" });
  state = reduceVoiceEvent(state, { ...base, type: "session.ready" });
  state = reduceVoiceCommand(state, { type: "turn.begin", turnId: "turn-1" });
  state = reduceVoiceEvent(state, { ...base, type: "transcript.final", text: "Hello" });
  state = reduceVoiceEvent(state, { ...base, type: "assistant.audio.started" });
  state = reduceVoiceEvent(state, { ...base, type: "assistant.audio.finished" });
  assert.equal(state.state, "LISTENING");
});

test("does not play a delayed audio event from the previous turn", () => {
  let state = reduceVoiceCommand(initialVoiceSnapshot, { type: "session.connect" });
  state = reduceVoiceEvent(state, { ...base, type: "session.ready" });
  state = reduceVoiceCommand(state, { type: "turn.begin", turnId: "turn-4" });
  state = reduceVoiceCommand(state, { type: "barge_in", reason: "speech_detected" });
  state = reduceVoiceCommand(state, { type: "turn.begin", turnId: "turn-5" });
  const delayed = reduceVoiceEvent(state, { ...base, turnId: "turn-4", type: "assistant.audio.started" });
  assert.equal(delayed.state, "USER_SPEAKING");
  assert.equal(delayed.activeTurnId, "turn-5");
});

test("reconnect returns to ready without reviving the old turn", () => {
  let state = reduceVoiceCommand(initialVoiceSnapshot, { type: "session.connect" });
  state = reduceVoiceEvent(state, { ...base, type: "session.ready" });
  state = reduceVoiceCommand(state, { type: "turn.begin", turnId: "turn-1" });
  state = reduceVoiceCommand(state, { type: "reconnect" });
  state = reduceVoiceCommand(state, { type: "session.reconnected" });
  assert.equal(state.state, "READY");
  assert.equal(state.activeTurnId, null);
});
