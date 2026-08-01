/** Downsample worklet PCM to 16kHz mono int16 and emit base64 chunks (server_vad_v1). */

export const SERVER_PCM_RATE = 16000;
export const PCM_CHUNK_MS = 100;

/** Linear downsample from the AudioContext rate to 16kHz. */
export function downsampleTo16k(samples: Float32Array, inputSampleRate: number): Float32Array {
  if (inputSampleRate === SERVER_PCM_RATE) return samples;
  const ratio = inputSampleRate / SERVER_PCM_RATE;
  const outLength = Math.floor(samples.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const pos = i * ratio;
    const base = Math.floor(pos);
    const frac = pos - base;
    const a = samples[base] ?? 0;
    const b = samples[Math.min(base + 1, samples.length - 1)] ?? 0;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** Float32 [-1,1] → little-endian int16 bytes → base64. */
export function floatToPcm16Base64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(i * 2, Math.round(clamped * 32767), true);
  }
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

export class PcmChunkStreamer {
  private pending: number[] = [];
  private readonly chunkSamples: number;

  constructor(
    private readonly options: {
      inputSampleRate: number;
      send: (pcmBase64: string) => void;
      chunkMs?: number;
    },
  ) {
    this.chunkSamples = SERVER_PCM_RATE * ((options.chunkMs ?? PCM_CHUNK_MS) / 1000);
  }

  push(samples: Float32Array): void {
    const down = downsampleTo16k(samples, this.options.inputSampleRate);
    for (let i = 0; i < down.length; i += 1) this.pending.push(down[i]!);
    while (this.pending.length >= this.chunkSamples) {
      const chunk = this.pending.splice(0, this.chunkSamples);
      this.options.send(floatToPcm16Base64(Float32Array.from(chunk)));
    }
  }

  flush(): void {
    if (this.pending.length === 0) return;
    const rest = this.pending.splice(0);
    this.options.send(floatToPcm16Base64(Float32Array.from(rest)));
  }
}
