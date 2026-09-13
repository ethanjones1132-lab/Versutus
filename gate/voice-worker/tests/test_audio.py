"""PCM16 helpers shared by every stage. Standard library and numpy only."""

import math

import numpy as np

from versutus_voice import audio


def _sine(freq, rate, seconds, amplitude=0.5):
    t = np.arange(int(rate * seconds)) / rate
    return (amplitude * np.sin(2 * math.pi * freq * t)).astype(np.float32)


def test_pcm16_round_trip():
    samples = _sine(440, 16000, 0.1)
    pcm = audio.float32_to_pcm16(samples)
    back = audio.pcm16_to_float32(pcm)
    assert len(back) == len(samples)
    assert np.max(np.abs(back - samples)) < 1e-3


def test_resample_keeps_the_frequency():
    src = _sine(1000, 16000, 0.25)
    out = audio.resample_linear(src, 16000, 24000)
    assert abs(len(out) - 6000) <= 2
    crossings = int(np.sum(np.diff(np.signbit(out)) != 0))
    freq = crossings * 24000 / (2 * len(out))
    assert abs(freq - 1000) < 15


def test_chunk_round_trip_carries_rate_and_channels():
    pcm = audio.float32_to_pcm16(_sine(300, 16000, 0.02))
    chunk = audio.encode_chunk(pcm, 16000)
    assert chunk["sampleRate"] == 16000
    assert chunk["numChannels"] == 1
    data, rate, channels = audio.decode_chunk(chunk)
    assert data == pcm
    assert rate == 16000
    assert channels == 1
