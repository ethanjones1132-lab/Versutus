"""load_whisper names its device: a CUDA failure must read as a failure, not slow voice."""

import sys
import types

import pytest

from versutus_voice.server import WHISPER_LOCAL_FILES, load_whisper


def _models_dir(tmp_path):
    whisper = tmp_path / "whisper"
    whisper.mkdir()
    for name in WHISPER_LOCAL_FILES:
        (whisper / name).write_bytes(b"fake")
    return tmp_path


def _install_fake_whisper(monkeypatch, fail_cuda=False):
    calls = []

    class FakeModel:
        pass

    def fake_whisper_model(*args, **kwargs):
        calls.append(kwargs)
        if kwargs.get("device") == "cuda" and fail_cuda:
            raise RuntimeError("Library cublas64_12.dll is not found or cannot be loaded")
        return FakeModel()

    module = types.ModuleType("faster_whisper")
    module.WhisperModel = fake_whisper_model
    monkeypatch.setitem(sys.modules, "faster_whisper", module)
    return calls


def test_cuda_load_names_cuda(tmp_path, monkeypatch, capsys):
    calls = _install_fake_whisper(monkeypatch)
    load_whisper(_models_dir(tmp_path))
    assert calls[0]["device"] == "cuda"
    assert "whisper loaded on cuda" in capsys.readouterr().err


def test_cuda_failure_falls_back_and_names_the_error(tmp_path, monkeypatch, capsys):
    calls = _install_fake_whisper(monkeypatch, fail_cuda=True)
    load_whisper(_models_dir(tmp_path))
    assert [call["device"] for call in calls] == ["cuda", "cpu"]
    err = capsys.readouterr().err
    assert "cublas64_12.dll" in err
    assert "falling back to CPU" in err


def test_explicit_cpu_names_cpu(tmp_path, monkeypatch, capsys):
    calls = _install_fake_whisper(monkeypatch)
    load_whisper(_models_dir(tmp_path), cpu=True)
    assert [call["device"] for call in calls] == ["cpu"]
    assert "whisper loaded on cpu" in capsys.readouterr().err
