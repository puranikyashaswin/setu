/** Load / register the VAD AudioWorklet processor once per AudioContext. */

const WORKLET_URL = "/vad-processor.js";
const WORKLET_NAME = "vad-processor";

const ready = new WeakMap<AudioContext, Promise<void>>();

export function getVadProcessorName() {
  return WORKLET_NAME;
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
