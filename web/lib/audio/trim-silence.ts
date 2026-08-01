/** Trim leading/trailing silence from utterance PCM before STT. */

export const TRIM_PADDING_MS = 300;

function chunkRms(chunk: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < chunk.length; i += 1) {
    const sample = chunk[i]!;
    sum += sample * sample;
  }
  return Math.sqrt(sum / chunk.length);
}

export function trimUtteranceSilence(
  chunks: Float32Array[],
  sampleRate: number,
  options: {
    speechThreshold: number;
    paddingMs?: number;
  },
): Float32Array[] {
  if (chunks.length === 0) return chunks;

  const frameMs = (chunks[0]!.length / sampleRate) * 1000;
  const paddingFrames = Math.max(1, Math.ceil((options.paddingMs ?? TRIM_PADDING_MS) / frameMs));

  let firstSpeech = -1;
  let lastSpeech = -1;
  for (let i = 0; i < chunks.length; i += 1) {
    if (chunkRms(chunks[i]!) >= options.speechThreshold) {
      if (firstSpeech === -1) firstSpeech = i;
      lastSpeech = i;
    }
  }

  if (firstSpeech === -1) return chunks;

  const start = Math.max(0, firstSpeech - paddingFrames);
  const end = Math.min(chunks.length, lastSpeech + paddingFrames + 1);
  return chunks.slice(start, end);
}
