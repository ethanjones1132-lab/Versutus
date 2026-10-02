"""End-to-end: synthetic PCM through the real VAD, with injected models."""

import base64
import threading
import time

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


class GatedVad(VadSegmenter):
    """The real segmenter with the echo gate readable, for assertions."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.playback_calls = []

    def set_playback(self, on):
        self.playback_calls.append(bool(on))
        super().set_playback(on)

    @property
    def playback(self):
        return self._playback


class GatedWhileOwedVad(GatedVad):
    """Records, for every gate drop, whether a sentence was still owed."""

    def __init__(self, owed, **kwargs):
        super().__init__(**kwargs)
        self.owed = owed
        self.gated_with_pending = []

    def set_playback(self, on):
        if not on:
            self.gated_with_pending.append(self.owed())
        super().set_playback(on)


class HookedLock:
    """The synthesis lock, with a callback run the instant it is let go.

    It stands in for the thread that was scheduled the moment the worker
    released the lock and had not looked at the queue again.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self.after_release = None

    def __enter__(self):
        self._lock.acquire()
        return self

    def __exit__(self, *_exc):
        self._lock.release()
        hook, self.after_release = self.after_release, None
        if hook is not None:
            hook()


class RecordingTranscriber(PartialTranscriber):
    """Records what ``partial`` was handed, before the model bounds it."""

    def __init__(self, transcribe, **kwargs):
        super().__init__(transcribe, **kwargs)
        self.partial_bytes = []

    def partial(self, pcm):
        self.partial_bytes.append(len(pcm))
        return super().partial(pcm)


def _thread_spawn(threads):
    """The production spawn, with every worker recorded so a test can join it."""

    def spawn(fn):
        thread = threading.Thread(target=fn, daemon=True)
        threads.append(thread)
        thread.start()

    return spawn


def _join_all(threads, timeout=5):
    """Wait until no worker is alive. The main thread starts them all, so once
    it has done its last action this set is final."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        alive = [thread for thread in threads if thread.is_alive()]
        if not alive:
            return
        for thread in alive:
            thread.join(0.02)


def _slow_synth(seen, entered, release):
    """A synthesizer that holds its first sentence, the way Kokoro takes time."""
    def synth(sentence):
        seen.append(sentence)
        if len(seen) == 1:
            entered.set()
            release.wait(5)
        yield sentence.encode("ascii")

    return synth


def _spoken(events):
    return [base64.b64decode(params["chunk"]["data"]) for method, params in events if method == "voice.speechAudio"]


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


# ─── Round 4: one sentence at a time, and recognition off the audio loop ────


def _threaded_pipeline(events, synth, vad=None, transcriber=None, min_utterance_ms=0):
    """A pipeline on real worker threads, the way production runs it."""
    threads = []
    pipeline = VoicePipeline(
        # warmup_ms=0 and the production start_ms: these tests exercise
        # endpointing, not room calibration or VAD opening thresholds.
        vad=vad or VadSegmenter(is_speech=_energy, warmup_ms=0, start_ms=250),
        transcriber=transcriber or PartialTranscriber(lambda pcm, beam_size: "hello there"),
        turn_judge=None,
        synthesizer=SpeechSynthesizer(synth),
        emit=lambda method, params: events.append((method, params)),
        min_utterance_ms=min_utterance_ms,
        spawn=_thread_spawn(threads),
    )
    return pipeline, threads


def test_the_sentences_of_one_reply_are_spoken_in_order():
    # Two `speak` calls for one generation are two sentences of the same reply.
    # A thread per sentence put sentence two in the loudspeaker while sentence
    # one was still being generated: the reply overlapped itself (GV-1).
    events = []
    seen = []
    entered = threading.Event()
    release = threading.Event()
    pipeline, threads = _threaded_pipeline(events, _slow_synth(seen, entered, release))
    pipeline.open({"voiceSessionId": "vs-1"})

    pipeline.speak({"gen": 1, "text": "One. "})
    assert entered.wait(5)  # sentence one is still being generated
    pipeline.speak({"gen": 1, "text": "Two. "})
    time.sleep(0.05)  # give a racing sentence every chance to be heard
    assert events == []  # the second sentence has not started

    release.set()
    _join_all(threads)
    assert seen == ["One. ", "Two. "]
    assert _spoken(events) == [b"One. ", b"Two. "]
    assert [method for method, _params in events] == [
        "voice.speechAudio",
        "voice.speechDone",
        "voice.speechAudio",
        "voice.speechDone",
    ]


def test_the_echo_gate_stays_up_until_the_last_sentence_of_the_reply_is_done():
    # Dropping it per sentence let the loudspeaker of a sibling generation open
    # speech again, and that echo cancelled the live one (V-3).
    events = []
    vad = GatedVad(is_speech=_energy, warmup_ms=0, start_ms=250)
    played = []

    def synth(sentence):
        played.append(sentence)
        time.sleep(0.02)
        yield sentence.encode("ascii")

    pipeline, threads = _threaded_pipeline(events, synth, vad=vad)
    pipeline.open({"voiceSessionId": "vs-1"})
    pipeline.speak({"gen": 1, "text": "One. "})
    pipeline.speak({"gen": 1, "text": "Two. "})
    _join_all(threads)

    assert played == ["One. ", "Two. "]
    # Up for the reply, down exactly once it has all been spoken: dropping the
    # gate per sentence let the echo of a sibling open speech and cancel this
    # one (V-3).
    assert vad.playback_calls.count(False) == 1
    assert vad.playback_calls[-1] is False


def test_the_echo_gate_is_not_dropped_while_a_sentence_is_still_owed():
    # Deciding the queue was empty and dropping the gate were two steps with the
    # lock released between them, so a voice.speak landing there was queued but
    # never gated: the sentence about to be synthesised ran with the echo gate
    # down, and the loudspeaker could open speech over it (VOW-3).
    events = []
    holder = {}
    entered = threading.Event()
    release = threading.Event()

    def synth(sentence):
        entered.set()
        release.wait(5)
        yield sentence.encode("ascii")

    vad = GatedWhileOwedVad(
        lambda: bool(holder["pipeline"]._synth_jobs),
        is_speech=_energy,
        warmup_ms=0,
        start_ms=250,
    )
    pipeline, threads = _threaded_pipeline(events, synth, vad=vad)
    holder["pipeline"] = pipeline
    hook_lock = HookedLock()
    pipeline._synth_lock = hook_lock
    pipeline.open({"voiceSessionId": "vs-1"})
    pipeline.speak({"gen": 1, "text": "One. "})
    assert entered.wait(5)

    # The second sentence arrives the instant the worker lets go of the lock.
    hook_lock.after_release = lambda: pipeline.speak({"gen": 1, "text": "Two. "})
    release.set()
    _join_all(threads)

    assert _spoken(events) == [b"One. ", b"Two. "]
    # Never down with a sentence owed. The gate is what keeps the echo of the
    # loudspeaker out of the VAD while the PC is talking.
    assert vad.gated_with_pending == [False, False]


def test_a_cancelled_generation_never_reaches_the_synthesizer():
    events = []
    seen = []
    entered = threading.Event()
    release = threading.Event()
    pipeline, threads = _threaded_pipeline(events, _slow_synth(seen, entered, release))
    pipeline.open({"voiceSessionId": "vs-1"})

    pipeline.speak({"gen": 1, "text": "One. "})
    assert entered.wait(5)
    pipeline.speak({"gen": 1, "text": "Two. "})
    pipeline.cancelSpeech({"gen": 1})
    release.set()
    _join_all(threads)

    # The queued sentence is dropped, not started and cancelled halfway.
    assert seen == ["One. "]
    assert events == []


def test_a_failed_sentence_is_reported_and_the_next_one_still_speaks():
    events = []
    broken = {"now": True}

    def synth(sentence):
        if broken["now"]:
            raise RuntimeError("kokora says no")
        yield sentence.encode("ascii")

    pipeline, threads = _threaded_pipeline(events, synth)
    pipeline.open({"voiceSessionId": "vs-1"})
    pipeline.speak({"gen": 2, "text": "Broken.", "final": True})
    _join_all(threads)

    methods = [method for method, _params in events]
    # Both, or the Gate waits in "speaking" for the rest of the call (GV-2).
    assert methods == ["voice.error", "voice.speechDone"]
    assert events[0][1] == {"code": "tts_failed", "message": "kokora says no", "fatal": False, "gen": 2}
    assert events[1][1] == {"gen": 2}

    broken["now"] = False
    pipeline.speak({"gen": 3, "text": "Fine.", "final": True})
    _join_all(threads)
    assert _spoken(events) == [b"Fine."]
    assert [method for method, _params in events][-2:] == ["voice.speechAudio", "voice.speechDone"]


def test_a_sentence_that_fails_after_the_call_closed_reaches_nothing():
    # The generation is restarted at 0 every call, so a dead call's
    # speechDone {gen: 1} landing in the next one ends the next call's reply
    # early — the Gate matches it on the generation it is speaking.
    events = []
    entered = threading.Event()
    release = threading.Event()
    broken = {"now": True}

    def synth(sentence):
        if broken["now"]:
            entered.set()
            release.wait(5)
            raise RuntimeError("kokoro says no")
        yield sentence.encode("ascii")

    pipeline, threads = _threaded_pipeline(events, synth)
    pipeline.open({"voiceSessionId": "vs-1"})
    pipeline.speak({"gen": 1, "text": "Hello.", "final": True})
    assert entered.wait(5)  # the sentence is mid-generation
    pipeline.close({})  # ... when the call ends
    release.set()  # and only then does it fail
    _join_all(threads)

    # Neither the failure nor its speechDone belongs to a call that is over.
    assert events == []

    events.clear()
    broken["now"] = False
    pipeline.open({"voiceSessionId": "vs-2"})
    pipeline.speak({"gen": 1, "text": "Goodbye.", "final": True})
    _join_all(threads)
    assert [method for method, _params in events] == ["voice.speechAudio", "voice.speechDone"]


def test_recognition_leaves_the_audio_loop_free_to_hear_a_barge_in():
    # Whisper costs hundreds of ms per decode. Run inline, it held the stdin
    # loop, so no audio was read: barge-in was unheard and speech boundaries
    # were judged late (GV-8).
    events = []
    final_started = threading.Event()
    release_final = threading.Event()
    keep_speaking = threading.Event()

    def transcribe(pcm, beam_size):
        if beam_size == 5:
            final_started.set()
            release_final.wait(5)
        return "hello there"

    def synth(sentence):
        yield sentence.encode("ascii")
        keep_speaking.wait(5)  # the generation is still playing

    pipeline, threads = _threaded_pipeline(
        events, synth, transcriber=PartialTranscriber(transcribe)
    )
    pipeline.open({"voiceSessionId": "vs-1"})
    pipeline.speak({"gen": 3, "text": "Reading.", "final": True})
    pipeline.pushAudio({"chunk": encode_chunk(_tone(1500), 16000)})

    started = time.monotonic()
    pipeline.pushAudio({"chunk": encode_chunk(_silence(400), 16000)})
    elapsed = time.monotonic() - started
    assert elapsed < 0.1  # the utterance ended; the audio loop is free again
    assert final_started.wait(5)  # and the final decode is running off it

    pipeline.pushAudio({"chunk": encode_chunk(_tone(500), 16000)})
    assert time.monotonic() - started < 0.2
    # Heard while Whisper is still busy, which is the whole point.
    assert "voice.userSpeechStart" in [method for method, _params in events]

    release_final.set()
    keep_speaking.set()
    _join_all(threads)
    methods = [method for method, _params in events]
    assert methods.index("voice.partial") < methods.index("voice.final")
    assert methods[-1] == "voice.final"


def test_a_queued_partial_is_replaced_and_a_final_never_is():
    events = []
    decoded = []
    partial_started = threading.Event()
    release = threading.Event()

    def transcribe(pcm, beam_size):
        decoded.append(beam_size)
        if beam_size == 1:
            partial_started.set()
            release.wait(1.5)
        return "hello there"

    transcriber = RecordingTranscriber(transcribe)
    pipeline, threads = _threaded_pipeline(
        events, lambda text: [text.encode("ascii")], transcriber=transcriber
    )
    pipeline.open({"voiceSessionId": "vs-1"})
    pipeline.pushAudio({"chunk": encode_chunk(_tone(1500), 16000)})
    assert partial_started.wait(5)  # the first partial is decoding
    for _ in range(5):
        pipeline.pushAudio({"chunk": encode_chunk(_tone(1000), 16000)})
    pipeline.pushAudio({"chunk": encode_chunk(_silence(400), 16000)})
    release.set()
    _join_all(threads)

    # Five more partials were asked for and one was left: every partial is
    # another read of the same growing utterance, so only the newest is worth
    # decoding. The final behind it is never dropped.
    assert decoded == [1, 1, 5]
    assert [method for method, _params in events][-1] == "voice.final"


def test_utterances_are_finalised_in_the_order_they_ended():
    events = []
    finals = []

    def transcribe(pcm, beam_size):
        if beam_size != 5:
            return ""
        finals.append(len(pcm))
        return f"turn {len(finals)}"

    pipeline = VoicePipeline(
        # warmup_ms=0 and the production start_ms: these tests exercise
        # endpointing, not room calibration or VAD opening thresholds.
        vad=VadSegmenter(is_speech=_energy, warmup_ms=0, start_ms=250),
        transcriber=PartialTranscriber(transcribe),
        turn_judge=None,
        synthesizer=SpeechSynthesizer(lambda text: [text.encode("ascii")]),
        emit=lambda method, params: events.append((method, params)),
        # Synthesis runs on a thread in production; the fake keeps it inline.
        spawn=lambda fn: fn(),
    )
    pipeline.open({"voiceSessionId": "vs-1"})
    preroll = len(_silence(400))
    for utterance in (_tone(2000), _tone(500)):
        pipeline.pushAudio({"chunk": encode_chunk(_silence(400), 16000)})
        pipeline.pushAudio({"chunk": encode_chunk(utterance, 16000)})
        pipeline.pushAudio({"chunk": encode_chunk(_silence(400), 16000)})

    # The silence that opens the utterance is prepended and the silence that
    # ends it is still in the buffer, so each final is its own turn — and the
    # long one, which ended first, is the first to be sent.
    assert finals == [
        preroll + len(_tone(2000)) + preroll,
        preroll + len(_tone(500)) + preroll,
    ]
    assert [params["text"] for method, params in events if method == "voice.final"] == ["turn 1", "turn 2"]


def test_an_utterance_the_vad_never_closes_is_capped():
    from versutus_voice.server import MAX_UTTERANCE_SECONDS

    events = []
    pipeline = _pipeline(events)
    pipeline.open({"voiceSessionId": "vs-1"})
    # 70 s of unbroken tone: the VAD never hears a silence, so nothing ends the
    # utterance but the cap, and the buffer cannot grow for the whole call.
    for _ in range(70):
        pipeline.pushAudio({"chunk": encode_chunk(_tone(1000), 16000)})

    assert MAX_UTTERANCE_SECONDS == 30
    assert len([1 for method, _params in events if method == "voice.final"]) == 2
    # The open utterance is what is still buffered, and it is bounded.
    assert len(pipeline._buffer) <= MAX_UTTERANCE_SECONDS * 16000 * 2


def test_a_capped_utterance_is_forced_and_loses_no_audio():
    from versutus_voice.server import MAX_UTTERANCE_SECONDS

    events = []
    finals = []
    # Unsure at the first cut, confident at the second: exactly the verdicts
    # that made a capped segment disappear. A capped one is never judged, so
    # this judge is never consulted below.
    scores = iter([0.1, 0.9])

    class Recorder:
        """Records the whole segment, not the transcriber's 15 s window."""

        def partial(self, _pcm):
            return ""

        def final(self, pcm):
            finals.append(len(pcm))
            return f"turn {len(finals)}"

    pipeline = VoicePipeline(
        # warmup_ms=0 and the production start_ms: these tests exercise
        # endpointing, not room calibration or VAD opening thresholds.
        vad=VadSegmenter(is_speech=_energy, warmup_ms=0, start_ms=250),
        transcriber=Recorder(),
        turn_judge=TurnJudge(is_complete=lambda _window: next(scores, 0.9)),
        synthesizer=SpeechSynthesizer(lambda text: [text.encode("ascii")]),
        emit=lambda method, params: events.append((method, params)),
        min_utterance_ms=400,
        spawn=lambda fn: fn(),
    )
    pipeline.open({"voiceSessionId": "vs-1"})
    # 400 ms of silence opens nothing and is the whole preroll, so every byte
    # pushed below belongs to an utterance.
    pushed = len(_silence(400))
    pipeline.pushAudio({"chunk": encode_chunk(_silence(400), 16000)})
    for _ in range(70):
        pushed += len(_tone(1000))
        pipeline.pushAudio({"chunk": encode_chunk(_tone(1000), 16000)})

    # A cut that lands mid-word is what the judge calls unsure, so a capped
    # segment is forced: held, it was sent behind the segments that followed it
    # (reordered turns) or overwritten by them and never transcribed at all.
    # It is not a pause, so it is not an early end either.
    assert [method for method, _params in events] == ["voice.final", "voice.final"]
    # In time order: the first cut is the one the preroll opened, so the later
    # one is the longer.
    assert finals[0] < finals[1]
    # And nothing is lost: both capped segments and the open one are every byte
    # that was pushed.
    assert sum(finals) + len(pipeline._buffer) + len(pipeline._preroll) == pushed
    assert pipeline._pending is None
    assert len(pipeline._buffer) <= MAX_UTTERANCE_SECONDS * 16000 * 2


def test_a_partial_only_reads_the_tail_of_the_utterance():
    events = []
    transcriber = RecordingTranscriber(lambda pcm, beam_size: "hello there", max_seconds=15)
    pipeline = VoicePipeline(
        # warmup_ms=0 and the production start_ms: these tests exercise
        # endpointing, not room calibration or VAD opening thresholds.
        vad=VadSegmenter(is_speech=_energy, warmup_ms=0, start_ms=250),
        transcriber=transcriber,
        turn_judge=None,
        synthesizer=SpeechSynthesizer(lambda text: [text.encode("ascii")]),
        emit=lambda method, params: events.append((method, params)),
        # Synthesis runs on a thread in production; the fake keeps it inline.
        spawn=lambda fn: fn(),
    )
    pipeline.open({"voiceSessionId": "vs-1"})
    # 20 s of unbroken speech: every 600 ms window re-reads the utterance.
    for _ in range(20):
        pipeline.pushAudio({"chunk": encode_chunk(_tone(1000), 16000)})

    assert transcriber.partial_bytes
    assert max(transcriber.partial_bytes) <= 15 * 16000 * 2


def test_a_failed_decode_is_reported_and_the_call_keeps_hearing():
    events = []
    calls = {"n": 0}

    def transcribe(pcm, beam_size):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("onnx decode failed")
        return "hello there"

    pipeline = VoicePipeline(
        # warmup_ms=0 and the production start_ms: these tests exercise
        # endpointing, not room calibration or VAD opening thresholds.
        vad=VadSegmenter(is_speech=_energy, warmup_ms=0, start_ms=250),
        transcriber=PartialTranscriber(transcribe),
        turn_judge=None,
        synthesizer=SpeechSynthesizer(lambda text: [text.encode("ascii")]),
        emit=lambda method, params: events.append((method, params)),
        # Synthesis runs on a thread in production; the fake keeps it inline.
        spawn=lambda fn: fn(),
    )
    pipeline.open({"voiceSessionId": "vs-1"})
    pipeline.pushAudio({"chunk": encode_chunk(_tone(500), 16000)})
    pipeline.pushAudio({"chunk": encode_chunk(_silence(400), 16000)})
    assert events == [
        (
            "voice.error",
            {"code": "stt_failed", "message": "onnx decode failed", "fatal": False, "gen": None},
        )
    ]

    # One bad chunk is not the end of the call: the next turn is still heard.
    events.clear()
    pipeline.pushAudio({"chunk": encode_chunk(_tone(500), 16000)})
    pipeline.pushAudio({"chunk": encode_chunk(_silence(400), 16000)})
    assert events == [("voice.final", {"text": "hello there"})]


# ─── Round 4: one warm process, many calls ──────────────────────────────────


def test_a_cancelled_generation_does_not_silence_the_next_call():
    # The Gate keeps one worker warm and restarts generations at 0 every call,
    # so a cancellation remembered from the last call would silence this one.
    events = []
    seen = []
    entered = threading.Event()
    release = threading.Event()
    pipeline, threads = _threaded_pipeline(events, _slow_synth(seen, entered, release))
    pipeline.open({"voiceSessionId": "vs-1"})
    pipeline.pushAudio({"chunk": encode_chunk(_tone(500), 16000)})
    pipeline.pushAudio({"chunk": encode_chunk(_silence(400), 16000)})
    pipeline.speak({"gen": 1, "text": "Hello. ", "final": True})
    assert entered.wait(5)
    # The operator barges in, which cancels generation 1 mid-sentence.
    pipeline.pushAudio({"chunk": encode_chunk(_tone(500), 16000)})
    release.set()
    _join_all(threads)
    assert "voice.userSpeechStart" in [method for method, _params in events]
    pipeline.close({})

    events.clear()
    pipeline.open({"voiceSessionId": "vs-2"})
    pipeline.pushAudio({"chunk": encode_chunk(_tone(500), 16000)})
    pipeline.pushAudio({"chunk": encode_chunk(_silence(400), 16000)})
    pipeline.speak({"gen": 1, "text": "Goodbye. ", "final": True})
    _join_all(threads)

    assert _spoken(events) == [b"Goodbye. "]
    assert [method for method, _params in events] == [
        "voice.final",
        "voice.speechAudio",
        "voice.speechDone",
    ]
    assert [params["gen"] for method, params in events if method == "voice.speechDone"] == [1]


def test_work_left_from_the_last_call_never_reaches_the_next():
    events = []
    seen = []
    entered = threading.Event()
    release = threading.Event()
    vad = GatedVad(is_speech=_energy, warmup_ms=0, start_ms=250)
    pipeline, threads = _threaded_pipeline(
        events, _slow_synth(seen, entered, release), vad=vad, min_utterance_ms=400
    )
    pipeline.open({"voiceSessionId": "vs-1"})
    pipeline.speak({"gen": 1, "text": "Hello.", "final": True})
    assert entered.wait(5)  # a sentence is still being generated
    pipeline.close({})  # ... when the call ends

    events.clear()
    pipeline.open({"voiceSessionId": "vs-2"})
    # The echo gate of the last call's synthesis is not still up: left on, it
    # refuses the next operator's speech.
    assert vad.playback is False
    pipeline.pushAudio({"chunk": encode_chunk(_tone(500), 16000)})
    pipeline.pushAudio({"chunk": encode_chunk(_silence(400), 16000)})
    pipeline.speak({"gen": 1, "text": "Goodbye.", "final": True})
    release.set()
    _join_all(threads)

    assert [params["text"] for method, params in events if method == "voice.final"] == ["hello there"]
    assert _spoken(events) == [b"Goodbye."]


def test_a_finishing_worker_does_not_take_a_newer_workers_claim_with_it():
    # The worker hands its claim back under the lock that found the queue empty,
    # and again in its `finally`. A newer worker may claim it between the two; the
    # old one's `finally` then cleared the NEWER worker's claim, the next speak
    # spawned a second worker, and two threads were inside the synthesizer at once
    # (overlapping sentences, GV-1). Ownership is a token, so a worker only ever
    # releases a claim it still holds.
    events = []
    state = {"running": 0, "max": 0, "armed": False, "fired": False}
    counter = threading.Lock()
    first_entered = threading.Event()
    release_first = threading.Event()
    second_entered = threading.Event()
    release_second = threading.Event()

    def synth(sentence):
        with counter:
            state["running"] += 1
            state["max"] = max(state["max"], state["running"])
        try:
            if sentence == "One. ":
                first_entered.set()
                release_first.wait(5)
            if sentence == "Two. ":
                second_entered.set()
                release_second.wait(5)
            yield sentence.encode("ascii")
        finally:
            with counter:
                state["running"] -= 1

    pipeline, threads = _threaded_pipeline(events, synth)
    hook_lock = HookedLock()
    pipeline._synth_lock = hook_lock

    def after_handback():
        # The instant the worker has handed its claim back (flag empty) and let go
        # of the lock - before it reaches its `finally` - a sentence arrives.
        if state["armed"] and not state["fired"] and pipeline._synth_worker is None:
            state["fired"] = True
            pipeline.speak({"gen": 1, "text": "Two. "})

    original_exit = HookedLock.__exit__

    def exit_with_hook(self, *exc):
        original_exit(self, *exc)
        after_handback()

    hook_lock.__class__ = type("HandbackLock", (HookedLock,), {"__exit__": exit_with_hook})
    pipeline.open({"voiceSessionId": "vs-1"})
    pipeline.speak({"gen": 1, "text": "One. "})
    assert first_entered.wait(5)
    state["armed"] = True
    release_first.set()
    assert second_entered.wait(5)
    # The first worker is done (its `finally` has run); the second is still busy.
    threads[0].join(5)
    assert not threads[0].is_alive()
    pipeline.speak({"gen": 1, "text": "Three. "})
    release_second.set()
    _join_all(threads)

    assert state["max"] == 1, "two workers were inside the synthesizer at the same time"
    assert _spoken(events) == [b"One. ", b"Two. ", b"Three. "]


def test_a_sentence_cancelled_before_a_worker_claims_it_still_lowers_the_echo_gate():
    # The gate goes up when a sentence is queued and comes down when the worker
    # finishes the last one. A sentence cancelled while it was still queued never
    # reaches a worker, the drain finds an empty queue and returns, and nothing
    # lowered the gate for the rest of the call: every word the operator said was
    # judged against loudspeaker echo.
    vad = GatedVad(is_speech=_energy, warmup_ms=0, start_ms=250)
    spawned = []
    pipeline = VoicePipeline(
        vad=vad,
        transcriber=PartialTranscriber(lambda pcm, beam_size: "hello there"),
        turn_judge=None,
        synthesizer=SpeechSynthesizer(lambda text: [text.encode("ascii")]),
        emit=lambda method, params: None,
        spawn=spawned.append,
    )
    pipeline.open({"voiceSessionId": "vs-1"})
    pipeline.speak({"gen": 1, "text": "One. ", "final": True})
    assert vad.playback is True
    pipeline.cancelSpeech({"gen": 1})
    # The worker the speak scheduled now runs and finds nothing to do.
    for fn in spawned:
        fn()

    assert vad.playback is False
