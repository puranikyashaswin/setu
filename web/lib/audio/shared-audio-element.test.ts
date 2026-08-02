import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  __resetSharedAudioForTests,
  ensureSharedAudioElement,
  getSharedAudioElement,
  installSharedAudioUnlockListener,
  isSharedAudioUnlocked,
  pauseSharedAudioElement,
  unlockSharedAudioElement,
} from "./shared-audio-element";

describe("shared HTMLAudioElement", () => {
  let audioInstances: Array<{
    volume: number;
    src: string;
    currentTime: number;
    preload: string;
    onended: (() => void) | null;
    onerror: (() => void) | null;
    playCalls: number;
    loadCalls: number;
    play(): Promise<void>;
    pause(): void;
    load(): void;
    removeAttribute(): void;
  }>;

  const OriginalAudio = globalThis.Audio;

  beforeEach(() => {
    audioInstances = [];
    (globalThis as unknown as { Audio: unknown }).Audio = class {
      volume = 1;
      src = "";
      currentTime = 0;
      preload = "";
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      playCalls = 0;
      loadCalls = 0;
      constructor() {
        audioInstances.push(this);
      }
      play() {
        this.playCalls += 1;
        return Promise.resolve();
      }
      pause() {}
      load() {
        this.loadCalls += 1;
      }
      removeAttribute() {}
    };
    __resetSharedAudioForTests();
  });

  afterEach(() => {
    (globalThis as unknown as { Audio: unknown }).Audio = OriginalAudio;
    __resetSharedAudioForTests();
  });

  it("creates one element and reuses it across ensure calls", () => {
    const a = ensureSharedAudioElement();
    const b = ensureSharedAudioElement();
    assert.equal(a, b);
    assert.equal(audioInstances.length, 1);
    assert.equal(getSharedAudioElement(), a);
  });

  it("unlock plays silent src then pause without load() reset", async () => {
    unlockSharedAudioElement();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(isSharedAudioUnlocked(), true);
    assert.equal(audioInstances[0]!.playCalls, 1);
    // iOS: load() after unlock revokes media engagement — must stay 0.
    assert.equal(audioInstances[0]!.loadCalls, 0);
  });

  it("pauseSharedAudioElement does not call load()", async () => {
    unlockSharedAudioElement();
    await new Promise((r) => setTimeout(r, 0));
    const before = audioInstances[0]!.loadCalls;
    pauseSharedAudioElement();
    assert.equal(audioInstances[0]!.loadCalls, before);
  });

  it("installSharedAudioUnlockListener unlocks on pointerdown", async () => {
    const handlers: Record<string, () => void> = {};
    const fakeRoot = {
      addEventListener(type: string, fn: () => void) {
        handlers[type] = fn;
      },
      removeEventListener(type: string) {
        delete handlers[type];
      },
    };
    const remove = installSharedAudioUnlockListener(fakeRoot as unknown as HTMLElement);
    handlers.pointerdown?.();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(isSharedAudioUnlocked(), true);
    remove();
  });
});
