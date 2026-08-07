"""Small dependency-free PCM16 normalization helpers for the media boundary."""

from __future__ import annotations

import struct


def normalize_pcm16_mono(
    data: bytes,
    *,
    sample_rate: int,
    channels: int,
    target_sample_rate: int = 16_000,
) -> bytes:
    """Downmix little-endian PCM16 and linearly resample to one target rate."""

    if not data:
        return b""
    if sample_rate <= 0 or channels <= 0 or target_sample_rate <= 0:
        raise ValueError("sample rates and channels must be positive")
    sample_width = 2
    usable = len(data) - (len(data) % (sample_width * channels))
    if usable == 0:
        return b""
    values = struct.unpack(f"<{usable // sample_width}h", data[:usable])
    mono = [
        int(sum(values[index : index + channels]) / channels)
        for index in range(0, len(values), channels)
    ]
    if sample_rate == target_sample_rate or len(mono) == 1:
        return struct.pack(f"<{len(mono)}h", *mono)

    output_count = max(1, round(len(mono) * target_sample_rate / sample_rate))
    output: list[int] = []
    scale = sample_rate / target_sample_rate
    for output_index in range(output_count):
        position = output_index * scale
        left = min(int(position), len(mono) - 1)
        right = min(left + 1, len(mono) - 1)
        fraction = position - left
        value = round(mono[left] + (mono[right] - mono[left]) * fraction)
        output.append(max(-32768, min(32767, value)))
    return struct.pack(f"<{len(output)}h", *output)
