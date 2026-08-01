import assert from "node:assert/strict";
import test from "node:test";

import { ServerVadTurnController, VoiceV2SessionManager } from "./voice-turn-v2";

test("manager: startup pending → ready locks server_vad_v1 for session", () => {
  const manager = new VoiceV2SessionManager("server_vad_v1");
  assert.equal(manager.serverVadActive, false);
  manager.noteReady("webrtc");
  assert.equal(manager.serverVadActive, true);
});

test("manager: startup timeout falls back with startup_timeout", () => {
  const manager = new VoiceV2SessionManager("server_vad_v1");
  manager.noteStartupTimeout();
  assert.equal(manager.serverVadActive, false);
  // Late ready must NOT resurrect server mode after a legacy lock-in.
  manager.noteReady("webrtc");
  assert.equal(manager.serverVadActive, false);
});

test("manager: mode_mismatch fallback (live_v2 → legacy)", () => {
  const manager = new VoiceV2SessionManager("server_vad_v1");
  manager.noteModeMismatch("live_v2");
  assert.equal(manager.serverVadActive, false);
});

test("manager: ws_error fallback after ready", () => {
  const manager = new VoiceV2SessionManager("server_vad_v1");
  manager.noteReady("webrtc");
  manager.noteWsError();
  assert.equal(manager.serverVadActive, false);
});

test("manager: no mid-session fallback for late noncritical events", () => {
  const manager = new VoiceV2SessionManager("server_vad_v1");
  manager.noteReady("webrtc");
  // A delayed/late event is not a fallback trigger — nothing to call.
  assert.equal(manager.serverVadActive, true);
  manager.noteStartupTimeout(); // ignored: not in startup_pending anymore
  assert.equal(manager.serverVadActive, true);
});

test("manager: legacy_client request ignores ready entirely", () => {
  const manager = new VoiceV2SessionManager("legacy_client");
  manager.noteReady("webrtc");
  assert.equal(manager.serverVadActive, false);
});

test("controller: accepts events for own turn in order, rejects stale turns", () => {
  let finalized = 0;
  const controller = new ServerVadTurnController(3, {
    onFinalized: () => { finalized += 1; },
  });
  assert.equal(controller.handleEvent({ type: "vad_speech_start", turn_id: 2, sequence: 1 }), false);
  assert.equal(controller.handleEvent({ type: "vad_speech_start", turn_id: 3, sequence: 1 }), true);
  assert.equal(controller.handleEvent({ type: "vad_speech_end_candidate", turn_id: 3, sequence: 2 }), true);
  assert.equal(controller.handleEvent({ type: "turn_finalized", turn_id: 3, sequence: 3, turn_finalize_reason: "vad_silence" }), true);
  assert.equal(finalized, 1);
});

test("controller: duplicate and out-of-order sequences rejected", () => {
  let starts = 0;
  let finalized = 0;
  const controller = new ServerVadTurnController(4, {
    onFinalized: () => { finalized += 1; },
    onSpeechStart: () => { starts += 1; },
  });
  assert.equal(controller.handleEvent({ type: "vad_speech_start", turn_id: 4, sequence: 2 }), true);
  assert.equal(controller.handleEvent({ type: "vad_speech_start", turn_id: 4, sequence: 2 }), false);
  assert.equal(controller.handleEvent({ type: "vad_speech_start", turn_id: 4, sequence: 1 }), false);
  assert.equal(starts, 1);
  assert.equal(controller.handleEvent({ type: "turn_finalized", turn_id: 4, sequence: 3 }), true);
  // Late duplicate turn_finalized must not fire again.
  assert.equal(controller.handleEvent({ type: "turn_finalized", turn_id: 4, sequence: 4 }), false);
  assert.equal(finalized, 1);
});

test("controller: semantic_turn_wait does not finalize or flip state", () => {
  let finalized = 0;
  let endCandidates = 0;
  const controller = new ServerVadTurnController(5, {
    onFinalized: () => { finalized += 1; },
    onEndCandidate: () => { endCandidates += 1; },
  });
  controller.handleEvent({ type: "vad_speech_start", turn_id: 5, sequence: 1 });
  assert.equal(controller.handleEvent({ type: "semantic_turn_wait", turn_id: 5, sequence: 2 }), false);
  assert.equal(finalized, 0);
  assert.equal(controller.handleEvent({ type: "vad_speech_end_candidate", turn_id: 5, sequence: 3 }), true);
  assert.equal(endCandidates, 1);
  assert.equal(finalized, 0);
});
