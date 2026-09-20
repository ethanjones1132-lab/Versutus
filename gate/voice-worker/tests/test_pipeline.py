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
        # warmup_ms=0 and the production start_ms: these tests exercise
        # endpointing, not room calibration or VAD opening thresholds.
        vad=VadSegmenter(is_speech=_energy, warmup_ms=0, start_ms=250),
        transcriber=PartialTranscriber(lambda pcm, beam_size: "hello there"),
        turn_judge=None,
        synthesizer=SpeechSynthesizer(lambda text: [text.encode("ascii")]),
        emit=lambda method, params: events.append((method, params)),
        # Synthesis runs on a thread in production; the fake keeps it inline.
        spawn=lambda fn: fn(),
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
        # warmup_ms=0 and the production start_ms: these tests exercise
        # endpointing, not room calibration or VAD opening thresholds.
        vad=VadSegmenter(is_speech=_energy, warmup_ms=0, start_ms=250),
        transcriber=PartialTranscriber(lambda pcm, beam_size: "barge in"),
        turn_judge=None,
        synthesizer=SpeechSynthesizer(synth),
        emit=lambda method, params: events.append((method, params)),
        spawn=lambda fn: fn(),
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
        # warmup_ms=0 and the production start_ms: these tests exercise
        # endpointing, not room calibration or VAD opening thresholds.
        vad=VadSegmenter(is_speech=_energy, warmup_ms=0, start_ms=250),
        transcriber=PartialTranscriber(lambda pcm, beam_size: "hello there"),
        turn_judge=TurnJudge(is_complete=lambda window: 0.9),
        synthesizer=SpeechSynthesizer(lambda text: [text.encode("ascii")]),
        emit=lambda method, params: events.append((method, params)),
        spawn=lambda fn: fn(),
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
        # warmup_ms=0 and the production start_ms: these tests exercise
        # endpointing, not room calibration or VAD opening thresholds.
        vad=VadSegmenter(is_speech=_energy, warmup_ms=0, start_ms=250),
        transcriber=PartialTranscriber(lambda pcm, beam_size: "hello there"),
        turn_judge=TurnJudge(is_complete=lambda window: 0.1),
        synthesizer=SpeechSynthesizer(lambda text: [text.encode("ascii")]),
        emit=lambda method, params: events.append((method, params)),
        spawn=lambda fn: fn(),
    )
    pipeline.open({"voiceSessionId": "vs-1"})
    pipeline.pushAudio({"chunk": encode_chunk(_tone(500), 16000)})
    pipeline.pushAudio({"chunk": encode_chunk(_silence(400), 16000)})
    assert "voice.earlyEnd" not in [method for method, _params in events]


# §4.6 step 3, retuned in round 3: an incomplete verdict is a thinking pause,
# not a turn. The worker holds the audio and re-judges at 800 ms of silence,
# forcing at 2.8 s — the old 1.6 s force point sent the turn while the
# operator was still mid-thought ("there is no option to continue talking").
def _unsure_pipeline(events, is_complete):
    return VoicePipeline(
        # warmup_ms=0 and the production start_ms: these tests exercise
        # endpointing, not room calibration or VAD opening thresholds.
        vad=VadSegmenter(is_speech=_energy, warmup_ms=0, start_ms=250),
        transcriber=PartialTranscriber(lambda pcm, beam_size: "hello there"),
        turn_judge=TurnJudge(is_complete=is_complete),
        synthesizer=SpeechSynthesizer(lambda text: [text.encode("ascii")]),
        emit=lambda method, params: events.append((method, params)),
        spawn=lambda fn: fn(),
    )


def test_an_unsure_pause_holds_the_turn_instead_of_sending():
    events = []
    pipeline = _unsure_pipeline(events, lambda _window: 0.1)
    pipeline.open({"voiceSessionId": "vs-1"})
    pipeline.pushAudio({"chunk": encode_chunk(_tone(500), 16000)})
    # The VAD ends speech after 200 ms, which is the first judgement; it is
    # unsure, so nothing is sent while the operator is only thinking.
    pipeline.pushAudio({"chunk": encode_chunk(_silence(300), 16000)})
    assert "voice.final" not in [method for method, _params in events]


def test_a_held_turn_completes_when_the_re_judge_finds_the_pause_over():
    events = []
    calls = {"n": 0}

    def scorer(_window):
        calls["n"] += 1
        # Unsure at the first pause, confident at the 800 ms re-judge.
        return 0.1 if calls["n"] == 1 else 0.9

    pipeline = _unsure_pipeline(events, scorer)
    pipeline.open({"voiceSessionId": "vs-1"})
    pipeline.pushAudio({"chunk": encode_chunk(_tone(500), 16000)})
    pipeline.pushAudio({"chunk": encode_chunk(_silence(300), 16000)})
    pipeline.pushAudio({"chunk": encode_chunk(_silence(400), 16000)})
    assert "voice.final" not in [method for method, _params in events]

    pipeline.pushAudio({"chunk": encode_chunk(_silence(400), 16000)})
    assert [method for method, _params in events].count("voice.final") == 1


def test_an_endless_pause_is_forced_at_2800ms():
    events = []
    pipeline = _unsure_pipeline(events, lambda _window: 0.1)
    pipeline.open({"voiceSessionId": "vs-1"})
    pipeline.pushAudio({"chunk": encode_chunk(_tone(500), 16000)})
    pipeline.pushAudio({"chunk": encode_chunk(_silence(300), 16000)})
    # 200 ms (VAD) + 6 × 400 ms = 2600 ms of silence: judged incomplete at
    # every look, still held — a thinking pause is not a turn.
    for _ in range(6):
        pipeline.pushAudio({"chunk": encode_chunk(_silence(400), 16000)})
    assert "voice.final" not in [method for method, _params in events]

    pipeline.pushAudio({"chunk": encode_chunk(_silence(400), 16000)})
    assert [method for method, _params in events].count("voice.final") == 1


def test_speech_resuming_during_a_hold_keeps_one_utterance_and_sends_nothing():
    events = []
    seen = {}

    def transcribe(pcm, beam_size):
        seen[beam_size] = len(pcm)
        return "hello there"

    calls = {"n": 0}

    def scorer(_window):
        calls["n"] += 1
        # The first pause is a thinking pause; the second end of speech is
        # confident, so the held prefix and the resumed speech are one final.
        return 0.1 if calls["n"] == 1 else 0.9

    pipeline = VoicePipeline(
        # warmup_ms=0 and the production start_ms: these tests exercise
        # endpointing, not room calibration or VAD opening thresholds.
        vad=VadSegmenter(is_speech=_energy, warmup_ms=0, start_ms=250),
        transcriber=PartialTranscriber(transcribe),
        turn_judge=TurnJudge(is_complete=scorer),
        synthesizer=SpeechSynthesizer(lambda text: [text.encode("ascii")]),
        emit=lambda method, params: events.append((method, params)),
        spawn=lambda fn: fn(),
    )
    pipeline.open({"voiceSessionId": "vs-1"})
    pipeline.pushAudio({"chunk": encode_chunk(_tone(500), 16000)})
    pipeline.pushAudio({"chunk": encode_chunk(_silence(300), 16000)})
    pipeline.pushAudio({"chunk": encode_chunk(_tone(300), 16000)})
    assert "voice.final" not in [method for method, _params in events]

    pipeline.pushAudio({"chunk": encode_chunk(_silence(300), 16000)})
    assert [method for method, _params in events].count("voice.final") == 1
    # The held prefix rode into the final utterance, so a resumed thought is
    # not truncated to the audio that arrived after the pause.
    assert seen.get(5, 0) > 30_000



# Round 3: the live-call repro. A sentence with a 2 s mid-sentence pause must
# arrive as ONE turn ("there is no option to continue talking"), a cough is
# not a turn, and a real stop completes. The scripted scorers stand in for
# the measured Smart Turn v3.2 behaviour: unsure when the window ends
# mid-thought, confident when it holds a whole sentence.
def _scripted_pipeline(events, scores):
    scores = iter(scores)

    def scorer(_window):
        return next(scores, 0.9)

    return VoicePipeline(
        # warmup_ms=0 and the production start_ms: these tests exercise
        # endpointing, not room calibration or VAD opening thresholds.
        vad=VadSegmenter(is_speech=_energy, warmup_ms=0, start_ms=250),
        transcriber=PartialTranscriber(lambda pcm, beam_size: "hello there"),
        turn_judge=TurnJudge(is_complete=scorer),
        synthesizer=SpeechSynthesizer(lambda text: [text.encode("ascii")]),
        emit=lambda method, params: events.append((method, params)),
        min_utterance_ms=400,
        spawn=lambda fn: fn(),
    )


def test_a_two_second_mid_sentence_pause_arrives_as_one_turn():
    events = []
    pipeline = _scripted_pipeline(events, [0.1, 0.9])
    pipeline.open({"voiceSessionId": "vs-1"})
    pipeline.pushAudio({"chunk": encode_chunk(_tone(1500), 16000)})
    pipeline.pushAudio({"chunk": encode_chunk(_silence(2000), 16000)})
    # The pause is heard, judged unsure and held — nothing is sent, not even
    # an early end, while the operator is still mid-thought.
    methods = [method for method, _params in events]
    assert "voice.final" not in methods
    assert "voice.earlyEnd" not in methods

    pipeline.pushAudio({"chunk": encode_chunk(_tone(1500), 16000)})
    pipeline.pushAudio({"chunk": encode_chunk(_silence(500), 16000)})
    methods = [method for method, _params in events]
    assert methods.count("voice.final") == 1
    assert methods.count("voice.earlyEnd") == 1


def test_a_cough_is_not_a_turn():
    events = []
    pipeline = _scripted_pipeline(events, [0.9])
    pipeline.open({"voiceSessionId": "vs-1"})
    # A 200 ms blip never reaches the 250 ms VAD start window: no utterance
    # opens, so not even a confident judge can turn it into a final.
    pipeline.pushAudio({"chunk": encode_chunk(_tone(200), 16000)})
    pipeline.pushAudio({"chunk": encode_chunk(_silence(3000), 16000)})
    assert "voice.final" not in [method for method, _params in events]


def test_a_real_stop_completes_the_turn():
    events = []
    pipeline = _scripted_pipeline(events, [0.9])
    pipeline.open({"voiceSessionId": "vs-1"})
    pipeline.pushAudio({"chunk": encode_chunk(_tone(1500), 16000)})
    pipeline.pushAudio({"chunk": encode_chunk(_silence(500), 16000)})
    methods = [method for method, _params in events]
    assert methods.count("voice.earlyEnd") == 1
    assert methods.count("voice.final") == 1
