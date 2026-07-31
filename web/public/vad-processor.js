/**
 * AudioWorklet processor for RMS VAD + PCM capture.
 * Loaded from /vad-processor.js (must live under public/).
 */
class VadProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input || input.length === 0) {
      this.port.postMessage({ type: "silence", rms: 0 });
      return true;
    }
    let sum = 0;
    for (let i = 0; i < input.length; i += 1) {
      const sample = input[i];
      sum += sample * sample;
    }
    const rms = Math.sqrt(sum / input.length);
    const samples = new Float32Array(input.length);
    samples.set(input);
    this.port.postMessage({ type: "frame", rms, samples }, [samples.buffer]);
    return true;
  }
}

registerProcessor("vad-processor", VadProcessor);
