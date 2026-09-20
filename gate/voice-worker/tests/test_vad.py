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

    # These tests exercise boundary mechanics, not room calibration.
    return VadSegmenter(is_speech=energy, warmup_ms=0)


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


def _prob_segmenter(probs, seg=None):
    seg = seg or VadSegmenter(start_ms=250)
    events = []
    for prob in probs:
        events.extend(seg.push(prob))
    return events


def _calibrated_quiet(seg=None):
    """A quiet room's opening seconds: room tone the floor can learn from."""
    seg = seg or VadSegmenter(start_ms=250)
    _prob_segmenter([0.05] * 40, seg)
    return seg


def test_a_calibrated_quiet_room_keeps_the_fixed_threshold():
    # With the floor learned from room tone the gate is the plain 0.5
    # threshold: a probability just under it never opens, just over it does.
    assert _prob_segmenter([0.4] * 40, _calibrated_quiet()) == []
    events = _prob_segmenter([0.6] * 40, _calibrated_quiet())
    assert [event.kind for event in events] == ["speech_start"]


def test_speech_during_call_open_calibration_still_opens():
    # Calibration absorbs room tone, but it must never swallow the operator.
    # Holding speech-like windows for the first 500 ms cost the opening words
    # of a sentence spoken immediately ("The host voice engine is alive."
    # arrived as "voice engine is alive.").
    seg = VadSegmenter(start_ms=250)
    events = _prob_segmenter([0.9] * 16, seg)
    assert "speech_start" in [event.kind for event in events]


def test_room_tone_during_calibration_opens_nothing():
    seg = VadSegmenter(start_ms=250)
    assert _prob_segmenter([0.6] * 16, seg) == []


def test_steady_noise_raises_the_gate_until_it_no_longer_opens():
    # A loud room sits at a steady 0.55: with the fixed threshold alone this
    # opens an utterance every time (the live call's "Thank you." every few
    # seconds). Calibration lifts the gate above the noise from window one.
    assert _prob_segmenter([0.55] * 200) == []


def test_loud_room_tone_from_the_first_frame_never_opens():
    # The bootstrap case: 0.7 room tone is above the initial gate, so without
    # calibration it would open an utterance within 250 ms and sit in speech
    # forever. The warmup absorbs it and the floor ends above the noise.
    assert _prob_segmenter([0.7] * 200) == []


def test_real_speech_still_opens_above_a_raised_floor():
    # The room has been at 0.55 for a while (gate now ~0.8); speech at 0.9
    # is still clearly above the gate.
    seg = VadSegmenter(start_ms=250)
    _prob_segmenter([0.55] * 200, seg)
    events = _prob_segmenter([0.9] * 40, seg)
    assert "speech_start" in [event.kind for event in events]


def test_the_floor_only_tracks_windows_below_the_gate():
    # Windows that open speech must not feed the floor, or speech would raise
    # the gate on itself.
    seg = _calibrated_quiet()
    floor = seg._floor
    _prob_segmenter([0.9] * 40, seg)  # opens; the floor stays frozen
    assert seg._floor == floor


def test_playback_raises_the_gate_against_leaked_echo():
    # Echo that survives the phone's AEC can sit well above ordinary noise.
    # A room at a sustained 0.7 lifts the floor to its cap: the gate reaches
    # 0.85, so 0.87 echo opens while the PC speaks — except in playback mode,
    # where the gate may rise to 0.9 and the same echo is refused.
    seg = VadSegmenter(start_ms=250)
    _prob_segmenter([0.7] * 300, seg)
    seg.set_playback(True)
    assert _prob_segmenter([0.87] * 60, seg) == []
    seg.set_playback(False)
    events = _prob_segmenter([0.87] * 60, seg)
    assert "speech_start" in [event.kind for event in events]


def test_reset_restores_the_quiet_room_gate():
    seg = VadSegmenter(start_ms=250)
    _prob_segmenter([0.55] * 200, seg)
    seg.reset()
    # Room tone again after the reset: the floor relearns the quiet room and
    # ordinary speech opens.
    events = _prob_segmenter([0.6] * 40, _calibrated_quiet(seg))
    assert "speech_start" in [event.kind for event in events]
