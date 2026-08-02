/** Load / register the VAD AudioWorklet processor once per AudioContext. */

/**
 * Bump when vad-processor.js changes so Safari/CDN cannot pin a broken module.
 * Query string is part of addModule URL; SW also bypasses this path entirely.
 */
export const VAD_WORKLET_VERSION = "3";

export const WORKLET_URL = `/vad-processor.js?v=${VAD_WORKLET_VERSION}`;
const WORKLET_NAME = "vad-processor";

const ready = new WeakMap<AudioContext, Promise<void>>();

export function getVadProcessorName() {
  return WORKLET_NAME;
}

export function getVadWorkletUrl() {
  return WORKLET_URL;
}

export function ensureVadWorklet(context: AudioContext): Promise<void> {
  const existing = ready.get(context);
  if (existing) return existing;
  const pending = context.audioWorklet.addModule(WORKLET_URL).catch((error) => {
    ready.delete(context);
    throw error;
  });
  ready.set(context, pending);
  return pending;
}
