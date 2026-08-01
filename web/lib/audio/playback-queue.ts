/** Pure serial audio-part queue (testable without Web Audio). */

export type PlaybackQueueEvent =
  | { type: "start"; turnId: number; part: number; parts: number }
  | { type: "end"; turnId: number; part: number; parts: number; natural: boolean }
  | { type: "turn_done"; turnId: number }
  | { type: "stopped"; turnId: number };

export type PlaybackQueue = {
  turnId: number;
  active: boolean;
  currentPart: number;
  parts: number;
  /** Start part index (1-based). Returns false if another part is still active. */
  beginPart: (part: number) => boolean;
  /** Mark current part finished; returns true if turn fully done. */
  endPart: (natural?: boolean) => boolean;
  stop: () => void;
  drainEvents: () => PlaybackQueueEvent[];
};

let turnCounter = 0;

export function createPlaybackQueue(partCount: number, turnId?: number): PlaybackQueue {
  const id = turnId ?? ++turnCounter;
  const parts = Math.max(0, partCount);
  let currentPart = 0;
  let active = false;
  let stopped = false;
  const events: PlaybackQueueEvent[] = [];

  return {
    get turnId() {
      return id;
    },
    get active() {
      return active;
    },
    get currentPart() {
      return currentPart;
    },
    get parts() {
      return parts;
    },
    beginPart(part: number) {
      if (stopped) return false;
      if (active) return false;
      if (part !== currentPart + 1) return false;
      if (part > parts) return false;
      currentPart = part;
      active = true;
      events.push({ type: "start", turnId: id, part, parts });
      return true;
    },
    endPart(natural = true) {
      if (!active || stopped) return false;
      active = false;
      events.push({ type: "end", turnId: id, part: currentPart, parts, natural });
      if (currentPart >= parts) {
        events.push({ type: "turn_done", turnId: id });
        return true;
      }
      return false;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      active = false;
      events.push({ type: "stopped", turnId: id });
    },
    drainEvents() {
      return events.splice(0, events.length);
    },
  };
}

export function __resetPlaybackQueueTurnCounter(): void {
  turnCounter = 0;
}

/**
 * Simulate serial playback of N parts. Asserts beginPart fails while active.
 * Returns event log.
 */
export function playPartsSerially(partCount: number): PlaybackQueueEvent[] {
  const q = createPlaybackQueue(partCount);
  const all: PlaybackQueueEvent[] = [];
  for (let part = 1; part <= partCount; part += 1) {
    if (q.active) {
      throw new Error("cannot start next part while active");
    }
    if (!q.beginPart(part)) throw new Error(`beginPart(${part}) failed`);
    // Attempt overlapping start — must fail.
    if (q.beginPart(part + 1)) {
      throw new Error("overlapping beginPart succeeded");
    }
    q.endPart(true);
    all.push(...q.drainEvents());
  }
  return all;
}
