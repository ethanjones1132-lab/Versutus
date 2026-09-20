"""A noisy line must not become a stream of turns (live call, 2026-09-19).

The phone's line produced a "final" every 2-4 s, most 7-11 characters: short
blips the VAD opened on and Whisper wrote down as stock phrases.
"""

from versutus_voice.audio import encode_chunk, float32_to_pcm16
from versutus_voice.server import VoicePipeline, join_spoken_segments
from versutus_voice.stt import PartialTranscriber
from versutus_voice.tts import SpeechSynthesizer


def _pcm(ms, rate=16000):
    return float32_to_pcm16([0.0] * int(rate * ms / 1000))


class _Event:
    def __init__(self, kind):
        self.kind = kind


class OneUtteranceVad:
    """Opens and closes one utterance on the first chunk, then stays quiet."""

    silence_ms = 200

    def __init__(self):
        self.in_speech = False
        self._streams = 0

    def reset(self):
        self._streams = 0

    def stream(self, _pcm):
        self._streams += 1
        if self._streams == 1:
            return [_Event("speech_start"), _Event("speech_end")]
        return []


class _Segment:
    def __init__(self, text, no_speech_prob=0.0, avg_logprob=-0.2):
        self.text = text
        self.no_speech_prob = no_speech_prob
        self.avg_logprob = avg_logprob


def _pipeline(events, min_utterance_ms):
    return VoicePipeline(
        vad=OneUtteranceVad(),
        transcriber=PartialTranscriber(lambda pcm, beam_size: "Thank you."),
        turn_judge=None,
        synthesizer=SpeechSynthesizer(lambda text: [text.encode("ascii")]),
        emit=lambda method, params: events.append((method, params)),
        min_utterance_ms=min_utterance_ms,
        # Synthesis runs on a thread in production; the fake keeps it inline.
        spawn=lambda fn: fn(),
    )


def test_a_blip_shorter_than_the_minimum_is_not_a_turn():
    events = []
    pipeline = _pipeline(events, min_utterance_ms=400)
    pipeline.pushAudio({"chunk": encode_chunk(_pcm(200), 16000)})
    assert [method for method, _ in events if method == "voice.final"] == []


def test_an_utterance_at_the_minimum_is_a_turn():
    events = []
    pipeline = _pipeline(events, min_utterance_ms=400)
    pipeline.pushAudio({"chunk": encode_chunk(_pcm(600), 16000)})
    assert [params["text"] for method, params in events if method == "voice.final"] == ["Thank you."]


def test_segments_whisper_thinks_are_silence_are_dropped():
    segments = [
        _Segment(" What time is it", no_speech_prob=0.05, avg_logprob=-0.3),
        _Segment(" Thank you.", no_speech_prob=0.95, avg_logprob=-0.4),
        _Segment(" on the PC?", no_speech_prob=0.1, avg_logprob=-0.25),
    ]
    assert join_spoken_segments(segments) == "What time is it on the PC?"


def test_a_doubtful_segment_on_a_quiet_line_is_dropped():
    assert join_spoken_segments([_Segment(" you", no_speech_prob=0.7, avg_logprob=-1.4)]) == ""


def test_a_quiet_but_confident_segment_is_kept():
    # Soft speech can score high no-speech while Whisper is sure of the words.
    assert join_spoken_segments([_Segment(" yes", no_speech_prob=0.7, avg_logprob=-0.3)]) == "yes"


class LateStartVad:
    """Hears nothing on the first chunk, opens and closes on the second."""

    silence_ms = 200

    def __init__(self):
        self.in_speech = False
        self._streams = 0

    def reset(self):
        self._streams = 0

    def stream(self, _pcm):
        self._streams += 1
        if self._streams == 2:
            return [_Event("speech_start"), _Event("speech_end")]
        return []


def test_the_audio_just_before_speech_opens_is_kept():
    # The VAD opens only after it has heard enough speech, so the first word
    # lives in the chunk before; dropping it turned "The host..." into "Host...".
    heard = []
    events = []
    pipeline = VoicePipeline(
        vad=LateStartVad(),
        transcriber=PartialTranscriber(lambda pcm, beam_size: heard.append(len(pcm)) or "ok"),
        turn_judge=None,
        synthesizer=SpeechSynthesizer(lambda text: [text.encode("ascii")]),
        emit=lambda method, params: events.append((method, params)),
        spawn=lambda fn: fn(),
    )
    pipeline.pushAudio({"chunk": encode_chunk(_pcm(200), 16000)})
    pipeline.pushAudio({"chunk": encode_chunk(_pcm(300), 16000)})
    assert heard == [len(_pcm(200)) + len(_pcm(300))]
