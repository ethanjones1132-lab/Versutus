"""Benchmark accounting and selection without running a model."""

from dataclasses import replace
from types import SimpleNamespace

import pytest

from versutus_voice import tts_bench
from versutus_voice.kokoro import TtsConfig
from versutus_voice.tts import SpeechSynthesizer, split_sentences


def test_default_uses_live_settings_while_legacy_candidates_keep_their_threads():
    assert tts_bench.candidate_config("default", {}) == TtsConfig()
    assert tts_bench.candidate_config("first-phrase", {}) == TtsConfig()
    assert tts_bench.candidate_config("baseline", {}).intraThreads == 0
    assert tts_bench.candidate_config("cpu-8", {}).intraThreads == 8


@pytest.mark.parametrize("provider", ["cpu", "cuda"])
def test_explicit_provider_candidates_only_change_the_provider(provider):
    assert tts_bench.candidate_config(provider, {}) == replace(TtsConfig(), provider=provider)


def test_default_can_measure_its_cpu_fallback_but_explicit_cuda_cannot():
    profile = {
        "model": "kokoro-v1.0.onnx",
        "providers": ["CPUExecutionProvider"],
        "fallbacks": ["CUDAExecutionProvider unavailable"],
    }
    assert tts_bench.matches_profile(TtsConfig(), profile)
    assert not tts_bench.matches_profile(TtsConfig(provider="cuda"), profile)


def test_simulated_playback_counts_real_underrun_not_onset(monkeypatch):
    class Speech:
        sample_rate = 1000

        def speak(self, _text, gen):
            for _ in range(4):
                yield gen, bytes(2000)  # 1 s per chunk

    # The first three chunks build 3 s of uninterrupted playback from t=1.
    # The fourth arrives 500 ms after that buffer runs out.
    times = iter([0, 1, 1.5, 2.5, 4.5, 4.5])
    monkeypatch.setattr(tts_bench.time, "perf_counter", lambda: next(times))
    result = tts_bench.measure(Speech(), "One. Two. Three. Four.")
    assert result["firstPcmMs"] == 1000
    assert result["estimatedUnderrunMs"] == result["maxGapMs"] == 500
    assert result["gapCount"] == 1


@pytest.mark.parametrize("length", ["medium", "long"])
def test_clause_chunking_removes_round_two_gap_without_delaying_first_pcm(monkeypatch, length):
    now = 0

    def synthesize(text):
        nonlocal now
        words = len(text.split())
        now += 0.9 * words / 3.2 + 0.05
        return [bytes(2000 * words)]  # 3.2 words/s at 3200 samples/s

    monkeypatch.setattr(tts_bench.time, "perf_counter", lambda: now)
    text = tts_bench.SENTENCES[length]
    old = SpeechSynthesizer(synthesize, sample_rate=3200, chunk_words=8, chunk_remainder=False)
    new = SpeechSynthesizer(synthesize, sample_rate=3200, chunk_words=8)
    before = tts_bench.measure(old, text)
    after = tts_bench.measure(new, text)
    assert before["maxGapMs"] > 300
    assert after["firstPcmMs"] == before["firstPcmMs"]
    assert after["maxGapMs"] == 0


def test_four_sentence_playback_reports_separate_gap_percentiles(monkeypatch):
    calls = []
    gaps = iter([10, 100, 20, 200])

    def measure(_speech, text):
        calls.append(text)
        return {"maxGapMs": next(gaps)}

    monkeypatch.setattr(tts_bench, "measure", measure)
    assert tts_bench.measure_playback_replies(None, repeats=2) == {
        "medium": {"maxGapMs": {"p50": 10, "p90": 20}},
        "long": {"maxGapMs": {"p50": 100, "p90": 200}},
    }
    assert calls == [" ".join((tts_bench.SENTENCES[length], *tts_bench.REPLY_FOLLOWUP))
                     for length in ("medium", "long") * 2]
    assert all(len(split_sentences(text)) == 4 for text in calls)


def test_after_idle_pauses_before_every_sample_and_reports_each_length(monkeypatch):
    events = []
    now = [0]
    calls = iter([10, 20, 30, 40, 50, 60])

    class Speech:
        last_used = 0

        def clock(self):
            return now[0]

        def prime(self):
            events.append("prime")
            self.last_used = now[0]
            return 7

    def sleep(seconds):
        events.append(seconds)
        now[0] += seconds

    def measure(speech, text):
        events.append(text)
        speech.last_used = now[0]
        return {"firstPcmMs": next(calls)}

    monkeypatch.setattr(tts_bench.time, "sleep", sleep)
    monkeypatch.setattr(tts_bench, "measure", measure)
    row = tts_bench.measure_after_idle(Speech(), TtsConfig(idleSeconds=5), repeats=2, idle_seconds=5)
    assert events == [part for text in list(tts_bench.SENTENCES.values()) * 2 for part in (5, "prime", text)]
    assert row["callOpenWarmupCount"] == 6
    assert row["callOpenWarmupMs"] == {"p50": 7, "p90": 7}
    assert row["short"]["firstPcmMs"] == {"p50": 10, "p90": 40}
    assert row["medium"]["firstPcmMs"] == {"p50": 20, "p90": 50}
    assert row["long"]["firstPcmMs"] == {"p50": 30, "p90": 60}


def test_candidates_filter_only_launches_selected_processes(monkeypatch):
    commands = []

    def run(command, **_):
        commands.append(command)
        return SimpleNamespace(stdout="", stderr="", returncode=0)

    monkeypatch.setattr(tts_bench.subprocess, "run", run)
    monkeypatch.setattr(tts_bench.sys, "argv", [
        "bench", "--models-dir", "models", "--candidates", "baseline,default",
        "--idle-seconds", "0", "--with-whisper",
    ])
    assert tts_bench.main() == 0
    assert [command[command.index("--candidate") + 1] for command in commands] == ["baseline", "default"]
    assert all(command[command.index("--idle-seconds") + 1] == "0" for command in commands)
    assert all("--with-whisper" in command for command in commands)
