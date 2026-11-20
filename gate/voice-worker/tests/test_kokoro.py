"""TTS configuration and warm-up tests with no ONNX assets or vendor runtime."""

import json
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from versutus_voice.kokoro import (
    KokoroSynthesizer,
    TtsConfig,
    last_tts_latency,
    load_kokoro_speech,
    read_tts_config,
    record_tts_latency,
)
from versutus_voice.server import VoicePipeline, _warm_models
from versutus_voice.tts import SpeechSynthesizer, WARMUP_TEXT, first_phrase_chunks


class FakeOptions(SimpleNamespace):
    def add_session_config_entry(self, key, value):
        setattr(self, key, value)


class FakeSession:
    def __init__(self, providers):
        self.providers = providers
        self.fallback_disabled = False

    def get_providers(self):
        return self.providers

    def disable_fallback(self):
        self.fallback_disabled = True


class FakeOrt:
    ExecutionMode = SimpleNamespace(ORT_PARALLEL="parallel", ORT_SEQUENTIAL="sequential")
    GraphOptimizationLevel = SimpleNamespace(ORT_DISABLE_ALL="off", ORT_ENABLE_BASIC="basic",
                                             ORT_ENABLE_EXTENDED="extended", ORT_ENABLE_ALL="all")
    SessionOptions = FakeOptions

    def __init__(self, available=("CPUExecutionProvider",), silent_fallback=False):
        self.available = available
        self.calls = []
        self.silent_fallback = silent_fallback

    def get_available_providers(self):
        return self.available

    def preload_dlls(self, directory):
        assert directory == ""

    def InferenceSession(self, path, *, sess_options, providers):
        actual = ["CPUExecutionProvider"] if self.silent_fallback else providers
        session = FakeSession(actual)
        self.calls.append((Path(path).name, sess_options, providers, session))
        return session


class FakeKokoro:
    def __init__(self):
        self.calls = []

    @classmethod
    def from_session(cls, session, path):
        assert session.fallback_disabled
        assert Path(path).name == "voices-v1.0.bin"
        return cls()

    def create(self, text, **options):
        self.calls.append((text, options))
        return np.array([0.25], dtype=np.float32), 24000


def model_dir(tmp_path, *, int8=False):
    models = tmp_path / "models"
    models.mkdir()
    for name in ("kokoro-v1.0.onnx", "voices-v1.0.bin"):
        (models / name).touch()
    if int8:
        (models / "kokoro-v1.0.int8.onnx").touch()
    return models


def test_default_profile_matches_measured_cpu_settings(tmp_path, monkeypatch):
    monkeypatch.setattr("versutus_voice.kokoro.os.cpu_count", lambda: 16)
    models = model_dir(tmp_path)
    config = read_tts_config(models)
    ort = FakeOrt()
    speech = load_kokoro_speech(models, config, ort=ort, kokoro_cls=FakeKokoro)
    name, options, providers, _ = ort.calls[0]

    assert name == "kokoro-v1.0.onnx"
    assert providers == ["CPUExecutionProvider"]
    assert config.voice == "af_sarah"
    assert config.warmup == "idle" and config.idleSeconds == 120
    assert speech.chunk_words == 8 and not speech.chunk_all
    assert (options.intra_op_num_threads, options.inter_op_num_threads) == (4, 1)
    assert (options.execution_mode, options.graph_optimization_level) == ("sequential", "extended")
    assert options.enable_cpu_mem_arena and options.enable_mem_pattern
    assert getattr(options, "session.intra_op.allow_spinning") == "0"
    assert getattr(options, "session.inter_op.allow_spinning") == "0"


@pytest.mark.parametrize(
    ("logical_cpus", "threads"),
    [(None, 1), (1, 1), (2, 1), (3, 1), (4, 2), (7, 3), (8, 4), (64, 4)],
)
def test_default_intra_threads_reserve_cores(logical_cpus, threads, monkeypatch):
    monkeypatch.setattr("versutus_voice.kokoro.os.cpu_count", lambda: logical_cpus)
    assert TtsConfig.from_mapping({}).intraThreads == threads
    assert TtsConfig.from_mapping({"intraThreads": 0}).intraThreads == threads
    assert TtsConfig.from_mapping({"intraThreads": 64}).intraThreads == threads
    assert TtsConfig.from_mapping({"intraThreads": 1}).intraThreads == 1


def test_config_selects_model_and_session_options(tmp_path, monkeypatch):
    monkeypatch.setattr("versutus_voice.kokoro.os.cpu_count", lambda: 16)
    models = model_dir(tmp_path, int8=True)
    (tmp_path / "voice.json").write_text(json.dumps({"tts": {
        "model": "int8", "chunkWords": 8, "intraThreads": 4, "interThreads": 2,
        "graphOptimization": "extended", "cpuArena": False, "memoryPattern": False, "spinning": False,
        "idleSeconds": True,  # not a valid integer setting
    }}), encoding="utf-8")
    ort = FakeOrt()
    speech = load_kokoro_speech(models, ort=ort, kokoro_cls=FakeKokoro)
    name, options, providers, _ = ort.calls[0]
    assert name == "kokoro-v1.0.int8.onnx"
    assert providers == ["CPUExecutionProvider"]
    assert (options.intra_op_num_threads, options.inter_op_num_threads) == (4, 2)
    assert (options.execution_mode, options.graph_optimization_level) == ("parallel", "extended")
    assert not options.enable_cpu_mem_arena and not options.enable_mem_pattern
    assert getattr(options, "session.intra_op.allow_spinning") == "0"
    assert speech.chunk_words == 8
    assert speech.synthesize.profile()["requested"]["idleSeconds"] == TtsConfig().idleSeconds
    assert speech.synthesize.profile()["fallbacks"] == []
    assert list(speech.speak("It works.", 1))


def test_missing_quantized_asset_uses_full_cpu_even_if_cuda_exists(tmp_path):
    models = model_dir(tmp_path)
    ort = FakeOrt(("CUDAExecutionProvider", "CPUExecutionProvider"))
    speech = load_kokoro_speech(models, TtsConfig(model="int8", provider="cuda"), ort=ort, kokoro_cls=FakeKokoro)
    assert [(name, providers) for name, _, providers, _ in ort.calls] == [
        ("kokoro-v1.0.onnx", ["CPUExecutionProvider"]),
    ]
    assert "missing" in speech.synthesize.profile()["fallbacks"][0]


def test_missing_cuda_or_silent_cuda_init_failure_falls_back(tmp_path):
    models = model_dir(tmp_path)
    for ort in (FakeOrt(), FakeOrt(("CUDAExecutionProvider", "CPUExecutionProvider"), silent_fallback=True)):
        speech = load_kokoro_speech(models, TtsConfig(provider="cuda"), ort=ort, kokoro_cls=FakeKokoro)
        assert speech.synthesize.profile()["providers"] == ["CPUExecutionProvider"]
        assert speech.synthesize.profile()["fallbacks"]
        assert list(speech.speak("CPU fallback.", 1))


def test_latency_snapshot_only_applies_to_the_matching_profile(tmp_path):
    models = model_dir(tmp_path)
    (tmp_path / "voice.json").write_text('{"tts":{"chunkWords":0}}', encoding="utf-8")
    config = read_tts_config(models)
    speech = load_kokoro_speech(models, config, ort=FakeOrt(), kokoro_cls=FakeKokoro)
    record_tts_latency(models, speech.synthesize.profile(), 510)
    assert last_tts_latency(models, config)["synthToFirstPcmMs"] == 510
    assert last_tts_latency(models, TtsConfig(chunkWords=8)) is None


def test_startup_and_idle_open_warm_the_real_call_adapter_and_voice_without_emitting_pcm():
    config = TtsConfig(voice="af_bella", chunkWords=8, idleSeconds=30)
    kokoro = FakeKokoro()
    now = [0]
    speech = SpeechSynthesizer(KokoroSynthesizer(kokoro, config, {}), chunk_words=8, clock=lambda: now[0])
    events = []
    work = []
    pipeline = VoicePipeline(
        vad=SimpleNamespace(reset=lambda: None), transcriber=None, turn_judge=None,
        synthesizer=speech, emit=lambda *event: events.append(event), spawn=work.append,
        tts_config=config,
    )
    _warm_models(lambda _pcm, _beam: None, speech, config)
    expected = list(first_phrase_chunks(WARMUP_TEXT, 8))
    assert len(expected) > 1
    assert [text for text, _ in kokoro.calls] == expected
    assert pipeline.open({"voiceSessionId": "first"})["ttsChunkWords"] == 8
    assert work == []
    pipeline.close({})
    now[0] += 31
    pipeline.open({"voiceSessionId": "second"})
    assert [text for text, _ in kokoro.calls] == expected
    work.pop()()  # call open returned before warm-up ran on the TTS lane
    assert [text for text, _ in kokoro.calls] == expected * 2
    assert events == []
    pipeline.speak({"gen": 1, "text": WARMUP_TEXT})
    work.pop()()
    assert [text for text, _ in kokoro.calls] == expected * 3
    assert all(options == {"voice": "af_bella", "speed": 1.0, "lang": "en-us"} for _, options in kokoro.calls)
    assert [method for method, _ in events] == ["voice.speechAudio"] * len(expected) + ["voice.speechDone"]


def test_worker_does_not_split_an_opening_already_cut_by_gate():
    kokoro = FakeKokoro()
    config = TtsConfig()
    speech = SpeechSynthesizer(KokoroSynthesizer(kokoro, config, {}), chunk_words=config.chunkWords)
    pipeline = VoicePipeline(
        vad=SimpleNamespace(reset=lambda: None), transcriber=None, turn_judge=None,
        synthesizer=speech, emit=lambda *_: None, spawn=lambda fn: fn(), tts_config=config,
    )
    pieces = [
        "You can start with this easy check, ",
        "before going through the entire setup from scratch in the new environment. ",
        "The next sentence should also be delivered in a single piece.",
    ]
    for job_text in (pieces[0], "".join(pieces[1:])):
        pipeline.speak({"gen": 1, "text": job_text, "splitOpening": False})
    assert [text for text, _ in kokoro.calls] == pieces


def test_streamed_opening_prefix_counts_toward_the_continuation_budget():
    kokoro = FakeKokoro()
    config = TtsConfig()
    speech = SpeechSynthesizer(KokoroSynthesizer(kokoro, config, {}), chunk_words=config.chunkWords)
    pipeline = VoicePipeline(
        vad=SimpleNamespace(reset=lambda: None), transcriber=None, turn_judge=None,
        synthesizer=speech, emit=lambda *_: None, spawn=lambda fn: fn(), tts_config=config,
    )
    opening = "I would start with the simplest option first, "
    continuation = "and then check whether the result matches what you expected. "
    later = "Then double-check the output."
    pipeline.speak({"gen": 1, "text": opening, "splitOpening": False})
    pipeline.speak({"gen": 1, "text": continuation + later, "splitOpening": False, "openingPrefixWords": 8})
    assert [text for text, _ in kokoro.calls] == [
        opening, "and then check ", "whether the result matches what you expected. ", later,
    ]


def test_worker_starts_next_sentence_before_previous_pcm_would_finish_playing():
    now = 0
    playback_end = 0
    timeline = []

    def synthesize(text):
        nonlocal now
        timeline.append(("render", text, now))
        now += 200  # 200 ms to synthesize 1 s of PCM
        return [bytes(48000)]

    def emit(method, _params):
        nonlocal playback_end
        if method != "voice.speechAudio":
            return
        playback_end = max(playback_end, now) + 1000
        timeline.append(("playback through", playback_end))

    speech = SpeechSynthesizer(synthesize, clock=lambda: now / 1000)
    pipeline = VoicePipeline(
        vad=SimpleNamespace(reset=lambda: None), transcriber=None, turn_judge=None,
        synthesizer=speech, emit=emit, spawn=lambda fn: fn(),
    )
    pipeline.speak({"gen": 1, "text": "First. Second."})
    assert timeline == [
        ("render", "First. ", 0),
        ("playback through", 1200),
        ("render", "Second.", 200),
        ("playback through", 2200),
    ]
