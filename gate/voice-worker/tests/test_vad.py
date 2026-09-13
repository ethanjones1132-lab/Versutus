"""VAD boundaries on synthetic silence and tone."""

import numpy as np

from versutus_voice.audio import float32_to_pcm16
from versutus_voice.vad import VadSegmenter


def _tone(ms, rate=16000, amp=0.4):
    n = int(rate * ms / 1000)
    t = np.arange(n) / rate
    return float32_to_pcm16(amp * np.sin(2 * np.pi * 220 * t))


def _silence(ms, rate=16000):
    return bytes(int(rate * ms / 1000) * 2)


def _segmenter():
    def energy(window):
        samples = np.frombuffer(window, dtype="<i2").astype(np.float32)
        return float(np.sqrt(np.mean(samples ** 2))) > 1000

    return VadSegmenter(is_speech=energy)


def test_a_tone_then_silence_marks_one_utterance():
    seg = _segmenter()
    events = seg.stream(_tone(500)) + seg.stream(_silence(400))
    kinds = [event.kind for event in events]
    assert kinds.count("speech_start") == 1
    assert kinds.count("speech_end") == 1
    assert kinds.index("speech_start") < kinds.index("speech_end")


def test_pure_silence_emits_nothing():
    assert _segmenter().stream(_silence(500)) == []


def test_a_blip_shorter_than_start_emits_nothing():
    assert _segmenter().stream(_tone(64)) == []
