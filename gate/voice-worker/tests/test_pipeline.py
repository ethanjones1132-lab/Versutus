"""End-to-end: synthetic PCM through the real VAD, with injected models."""

import numpy as np

from versutus_voice.audio import encode_chunk, float32_to_pcm16
from versutus_voice.server import VoicePipeline
from versutus_voice.stt import PartialTranscriber
from versutus_voice.tts import SpeechSynthesizer
from versutus_voice.turn import TurnJudge
from versutus_voice.vad import VadSegmenter


def _tone(ms, rate=16000):
    n = int(rate * ms / 1000)
    t = np.arange(n) / rate
    return float32_to_pcm16(0.4 * np.sin(2 * np.pi * 220 * t))


def _silence(ms, rate=16000):
    return bytes(int(rate * ms / 1000) * 2)


def _energy(window):
    samples = np.frombuffer(window, dtype="<i2").astype(np.float32)
    return float(np.sqrt(np.mean(samples ** 2))) > 1000


def _pipeline(events):
    return VoicePipeline(
        vad=VadSegmenter(is_speech=_energy),
        transcriber=PartialTranscriber(lambda pcm, beam_size: "hello there"),
        turn_judge=None,
        synthesizer=SpeechSynthesizer(lambda text: [text.encode("ascii")]),
        emit=lambda method, params: events.append((method, params)),
    )


def test_synthetic_speech_becomes_a_final_then_spoken_sentences():
    events = []
    pipeline = _pipeline(events)
    pipeline.open({"voiceSessionId": "vs-1"})

    pipeline.pushAudio({"chunk": encode_chunk(_tone(500), 16000)})
    pipeline.pushAudio({"chunk": encode_chunk(_silence(400), 16000)})
    assert [method for method, _params in events] == ["voice.final"]
    assert events[0][1]["text"] == "hello there"

    pipeline.speak({"gen": 1, "text": "One. Two.", "final": True})
    methods = [method for method, _params in events]
    assert methods[-3:] == ["voice.speechAudio", "voice.speechAudio", "voice.speechDone"]
    audio = [params for method, params in events if method == "voice.speechAudio"]
    assert {params["gen"] for params in audio} == {1}
    assert audio[0]["chunk"]["sampleRate"] == 24000


def test_a_cancelled_generation_speaks_nothing():
    events = []
    pipeline = _pipeline(events)
    pipeline.open({"voiceSessionId": "vs-1"})
    pipeline.cancelSpeech({"gen": 5})
    pipeline.speak({"gen": 5, "text": "Not this one.", "final": True})
    assert [method for method, _params in events] == []


def test_starting_to_talk_during_speech_barges_in_once_and_stops_the_generation():
    events = []
    holder = {}

    def synth(_sentence):
        yield b"\x01\x02"
        # The operator starts talking while this generation is being spoken.
        holder["pipeline"].pushAudio({"chunk": encode_chunk(_tone(500), 16000)})
        yield b"\x03\x04"

    pipeline = VoicePipeline(
        vad=VadSegmenter(is_speech=_energy),
        transcriber=PartialTranscriber(lambda pcm, beam_size: "barge in"),
        turn_judge=None,
        synthesizer=SpeechSynthesizer(synth),
        emit=lambda method, params: events.append((method, params)),
    )
    holder["pipeline"] = pipeline
    pipeline.open({"voiceSessionId": "vs-1"})
    pipeline.speak({"gen": 7, "text": "One. Two.", "final": True})

    methods = [method for method, _params in events]
    assert methods.count("voice.userSpeechStart") == 1
    audio = [params for method, params in events if method == "voice.speechAudio"]
    assert len(audio) == 1
    assert audio[0]["gen"] == 7
    assert "voice.speechDone" not in methods


def test_a_tone_while_listening_does_not_barge_in():
    events = []
    pipeline = _pipeline(events)
    pipeline.open({"voiceSessionId": "vs-1"})
    pipeline.pushAudio({"chunk": encode_chunk(_tone(500), 16000)})
    assert "voice.userSpeechStart" not in [method for method, _params in events]


def test_a_confident_turn_judge_marks_an_early_end_before_the_final():
    events = []
    pipeline = VoicePipeline(
        vad=VadSegmenter(is_speech=_energy),
        transcriber=PartialTranscriber(lambda pcm, beam_size: "hello there"),
        turn_judge=TurnJudge(is_complete=lambda window: 0.9),
        synthesizer=SpeechSynthesizer(lambda text: [text.encode("ascii")]),
        emit=lambda method, params: events.append((method, params)),
    )
    pipeline.open({"voiceSessionId": "vs-1"})
    pipeline.pushAudio({"chunk": encode_chunk(_tone(500), 16000)})
    pipeline.pushAudio({"chunk": encode_chunk(_silence(400), 16000)})

    methods = [method for method, _params in events]
    assert methods.index("voice.earlyEnd") < methods.index("voice.final")
    assert events[methods.index("voice.earlyEnd")][1]["text"] == "hello there"


def test_an_unsure_turn_judge_does_not_mark_an_early_end():
    events = []
    pipeline = VoicePipeline(
        vad=VadSegmenter(is_speech=_energy),
        transcriber=PartialTranscriber(lambda pcm, beam_size: "hello there"),
        turn_judge=TurnJudge(is_complete=lambda window: 0.1),
        synthesizer=SpeechSynthesizer(lambda text: [text.encode("ascii")]),
        emit=lambda method, params: events.append((method, params)),
    )
    pipeline.open({"voiceSessionId": "vs-1"})
    pipeline.pushAudio({"chunk": encode_chunk(_tone(500), 16000)})
    pipeline.pushAudio({"chunk": encode_chunk(_silence(400), 16000)})
    assert "voice.earlyEnd" not in [method for method, _params in events]
