"""PCM16 helpers shared by every stage.

Input and output are mono PCM16LE; the rates are fixed by the media protocol
(§4.6): 16 kHz from the phone, 24 kHz to the phone. Audio chunks cross the
stdio RPC in Codex's ``ThreadRealtimeAudioChunk`` shape, ``{data, sampleRate,
numChannels}`` with base64 ``data``, so the local and codex engines share one
internal type.
"""

import base64

import numpy as np

INPUT_SAMPLE_RATE = 16000
OUTPUT_SAMPLE_RATE = 24000
CHANNELS = 1
# Silero VAD reads 32 ms windows at 16 kHz (§4.6 step 1).
VAD_WINDOW_SAMPLES = 512


def pcm16_to_float32(data):
    samples = np.frombuffer(data, dtype="<i2").astype(np.float32)
    return samples / 32768.0


def float32_to_pcm16(samples):
    clipped = np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0)
    return (clipped * 32767.0).astype("<i2").tobytes()


def resample_linear(samples, src_rate, dst_rate):
    """Linear resample; enough for the 16 kHz <-> 24 kHz bridge (§4.6)."""
    source = np.asarray(samples, dtype=np.float32)
    if src_rate == dst_rate or source.size == 0:
        return source
    count = int(round(source.size * dst_rate / src_rate))
    if count <= 0:
        return np.zeros(0, dtype=np.float32)
    positions = np.linspace(0.0, source.size - 1, num=count, dtype=np.float64)
    return np.interp(positions, np.arange(source.size), source).astype(np.float32)


def encode_chunk(pcm, sample_rate, num_channels=CHANNELS):
    return {
        "data": base64.b64encode(pcm).decode("ascii"),
        "sampleRate": sample_rate,
        "numChannels": num_channels,
    }


def decode_chunk(chunk):
    pcm = base64.b64decode(chunk["data"])
    sample_rate = int(chunk["sampleRate"])
    channels = int(chunk.get("numChannels", CHANNELS))
    return pcm, sample_rate, channels
