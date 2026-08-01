import assert from "node:assert/strict";
import test from "node:test";

import { PcmChunkStreamer, downsampleTo16k, floatToPcm16Base64, SERVER_PCM_RATE } from "./pcm-stream";

test("downsampleTo16k: 48kHz → 16kHz reduces 3:1", () => {
  const input = new Float32Array(480);
  for (let i = 0; i < input.length; i += 1) input[i] = Math.sin(i / 10);
  const out = downsampleTo16k(input, 48000);
  assert.equal(out.length, 160);
  assert.ok(Math.abs(out[0]! - input[0]!) < 1e-6);
});

test("downsampleTo16k: passthrough at 16kHz", () => {
  const input = new Float32Array([0.1, -0.2, 0.3]);
  assert.equal(downsampleTo16k(input, SERVER_PCM_RATE), input);
});

test("floatToPcm16Base64: decodes to int16 little-endian", () => {
  const b64 = floatToPcm16Base64(new Float32Array([0, 1, -1, 0.5]));
  const bytes = Buffer.from(b64, "base64");
  assert.equal(bytes.length, 8);
  assert.equal(bytes.readInt16LE(0), 0);
  assert.equal(bytes.readInt16LE(2), 32767);
  assert.equal(bytes.readInt16LE(4), -32767);
  assert.equal(bytes.readInt16LE(6), Math.round(0.5 * 32767));
});

test("PcmChunkStreamer: emits exactly 100ms chunks and flushes remainder", () => {
  const sent: string[] = [];
  const streamer = new PcmChunkStreamer({
    inputSampleRate: 48000,
    send: (chunk) => sent.push(chunk),
  });
  // 250ms of 48kHz audio = 12000 samples → 2 full 100ms chunks (1600 samples each).
  streamer.push(new Float32Array(12000).fill(0.25));
  assert.equal(sent.length, 2);
  assert.equal(Buffer.from(sent[0]!, "base64").length, 1600 * 2);
  streamer.flush();
  assert.equal(sent.length, 3);
  assert.equal(Buffer.from(sent[2]!, "base64").length, 800 * 2); // 50ms remainder
  streamer.flush(); // second flush is a no-op
  assert.equal(sent.length, 3);
});
