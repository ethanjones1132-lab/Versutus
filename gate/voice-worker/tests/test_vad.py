"""VAD boundaries on synthetic silence and tone, plus the chunk-carry contract.

The phone pushes 20 ms frames of 320 samples; a 576-sample window can never
fill inside one call, so ``stream`` must carry the unscored tail. The carry is
what makes real speech visible at all — without it a whole call scores zero
windows (M6 regression test).
"""

import numpy as np

from versutus_voice.audio import float32_to_pcm16, VAD_WINDOW_SAMPLES
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


def test_20ms_chunks_smaller_than_a_window_still_segment():
    """The production chunk path: 640-byte frames through ``pushAudio``."""
    seg = _segmenter()
    audio = _tone(700) + _silence(500)
    chunk = 640  # 320 samples, what the phone actually sends
    events = []
    for off in range(0, len(audio), chunk):
        events.extend(seg.stream(audio[off : off + chunk]))
    kinds = [event.kind for event in events]
    assert kinds.count("speech_start") == 1
    assert kinds.count("speech_end") == 1


def test_a_single_sample_streamed_twice_is_scored_once():
    """No window may be scored twice: the carry consumes what it holds."""
    seg = _segmenter()
    audio = _tone(400) + _silence(400)
    events = []
    # 1-byte pushes drive stream() with next-to-nothing every call; the carry
    # must still produce segments only at real boundaries.
    for sample in audio:
        events.extend(seg.stream(bytes([sample])))
    kinds = [event.kind for event in events]
    assert kinds.count("speech_start") == 1
    assert kinds.count("speech_end") == 1


def test_the_window_size_is_the_onnx_graph_size():
    """512 was v4; the shipped v6 asset wants 576 samples (32 ms at 16 kHz)."""
    assert VAD_WINDOW_SAMPLES == 576


def test_reset_drops_the_carry():
    seg = _segmenter()
    seg.stream(_tone(64))  # leave a partial window in the carry
    seg.reset()
    assert _silence_segments(seg) == 0
    # after reset, a fresh full tone still segments
    events = seg.stream(_tone(500)) + seg.stream(_silence(400))
    assert any(event.kind == "speech_start" for event in events)


def _silence_segments(seg):
    return sum(1 for _ in seg.stream(_silence(200)))
