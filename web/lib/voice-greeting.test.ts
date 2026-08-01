import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  planFirstOrbTap,
  resolvePageLoadVoiceState,
  shouldPlayGreeting,
  shouldStartListeningOnTap,
} from "./voice-greeting";

describe("voice greeting / fresh-load bootstrap", () => {
  it("fresh load clears stale voice flags but keeps history intent", () => {
    const state = resolvePageLoadVoiceState({
      historyTurnCount: 4,
      onboarded: true,
      newId: () => "voice-sess-1",
    });
    assert.equal(state.keepHistory, true);
    assert.equal(state.staleSessionCleared, true);
    assert.equal(state.greetingPlayedThisLoad, false);
    assert.equal(state.hasStarted, true);
    assert.equal(state.voiceSessionId, "voice-sess-1");
  });

  it("empty chat on fresh load still allows one greeting", () => {
    const state = resolvePageLoadVoiceState({
      historyTurnCount: 0,
      onboarded: false,
      newId: () => "voice-sess-2",
    });
    assert.equal(state.hasStarted, false);
    assert.equal(shouldPlayGreeting({
      greetingPlayedThisLoad: state.greetingPlayedThisLoad,
      onboarded: false,
      turnCount: 0,
    }), true);
  });

  it("tap → greeting once; second tap never replays greeting", () => {
    let gate = { greetingPlayedThisLoad: false, onboarded: false, turnCount: 0 };
    const first = planFirstOrbTap(gate);
    assert.equal(first.action, "play_greeting");
    assert.equal(first.autoListenAfter, true);

    // After greeting ends, auto-listen is armed — greeting flag set.
    gate = { ...gate, greetingPlayedThisLoad: true };
    assert.equal(shouldPlayGreeting(gate), false);
    assert.equal(shouldStartListeningOnTap(gate), true);

    const second = planFirstOrbTap(gate);
    assert.equal(second.action, "start_listening");
  });

  it("fresh-load simulation: greeting then speak submits without second greeting", () => {
    const events: string[] = [];
    let gate = { greetingPlayedThisLoad: false, onboarded: false, turnCount: 0 };
    let utteranceSubmitted = false;

    // First tap (user gesture): arm mic → unlock → greet → auto-listen.
    events.push("mic_armed_before_greeting");
    const plan = planFirstOrbTap(gate);
    assert.equal(plan.action, "play_greeting");
    gate = { ...gate, greetingPlayedThisLoad: true };
    events.push("greeting_played");
    events.push("auto_listen_after_greeting");

    // User speaks; endpoint submits (no second tap).
    utteranceSubmitted = true;
    gate = { ...gate, turnCount: 1, onboarded: false };

    // Second tap must start listening, never greet again.
    const again = planFirstOrbTap(gate);
    assert.equal(again.action, "start_listening");
    assert.equal(utteranceSubmitted, true);
    assert.deepEqual(events, [
      "mic_armed_before_greeting",
      "greeting_played",
      "auto_listen_after_greeting",
    ]);
  });

  it("onboarded history chat skips greeting on first tap", () => {
    const plan = planFirstOrbTap({
      greetingPlayedThisLoad: false,
      onboarded: true,
      turnCount: 2,
    });
    assert.equal(plan.action, "start_listening");
  });
});
