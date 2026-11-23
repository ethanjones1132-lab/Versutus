"""The voice-live fixture script must synthesise on whatever provider really loads.

The quiet-box harness runs on a host where onnxruntime-gpu registers TensorRT and
CUDA EPs but their DLLs live only in the venv. A bare ``Kokoro(model, voices)``
inherits that EP order and dies before the call starts, so the script goes through
the worker's loader: pip CUDA DLLs preloaded, CUDA tried, CPU retried when the
session cannot be created. The JSON must name the providers actually used.
"""

import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np

SCRIPT_PATH = Path(__file__).resolve().parents[3] / "scripts" / "voice-live-fixtures.py"


def load_fixture_script():
    spec = importlib.util.spec_from_file_location("voice_live_fixtures", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    # Loading the script by path would write scripts/__pycache__/, which nothing
    # ignores (scripts/ has no .gitignore, unlike gate/voice-worker/).
    previous = sys.dont_write_bytecode
    sys.dont_write_bytecode = True
    try:
        spec.loader.exec_module(module)
    finally:
        sys.dont_write_bytecode = previous
    return module


class ProviderSession:
    def __init__(self, providers):
        self.providers = providers

    def get_providers(self):
        return list(self.providers)


class RegisteredButBrokenOrt:
    """TensorRT and CUDA are advertised, but only the CPU EP can load its DLLs."""

    def __init__(self, cuda_loads=False):
        self.available = ["TensorrtExecutionProvider", "CUDAExecutionProvider", "CPUExecutionProvider"]
        self.attempts = []
        self.preloads = 0
        self.cuda_loads = cuda_loads

    def get_available_providers(self):
        return self.available

    def preload_dlls(self, directory):
        assert directory == ""
        self.preloads += 1

    def InferenceSession(self, path, providers):
        self.attempts.append(list(providers))
        if providers[0] != "CPUExecutionProvider" and not self.cuda_loads:
            raise RuntimeError("Failed to load library nvinfer_1_0.dll")
        return ProviderSession(providers)


class ToneKokoro:
    """A stand-in for kokoro_onnx.Kokoro: a tenth of a second of 220 Hz."""

    created = []

    def __init__(self):
        self.calls = []

    @classmethod
    def from_session(cls, session, path):
        assert Path(path).name == "voices-v1.0.bin"
        instance = cls()
        instance.session = session
        return instance

    def create(self, text, **options):
        self.calls.append((text, options))
        ToneKokoro.created.append((text, options))
        rate = 24000
        t = np.arange(rate / 10) / rate
        return (0.5 * np.sin(2 * np.pi * 220 * t)).astype(np.float32), rate


def one_segment_manifest(tmp_path):
    models = tmp_path / "models"
    models.mkdir()
    for name in ("kokoro-v1.0.onnx", "voices-v1.0.bin"):
        (models / name).touch()
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps({
        "voice": "am_michael",
        "utterances": [
            {"id": "u1", "kind": "question", "segments": [{"text": "Hello there."}]},
        ],
    }), encoding="utf-8")
    return models, manifest


def test_fixtures_fall_back_to_cpu_and_never_claim_cuda(tmp_path, monkeypatch, capsys):
    models, manifest = one_segment_manifest(tmp_path)
    ort = RegisteredButBrokenOrt()
    monkeypatch.setitem(sys.modules, "onnxruntime", ort)
    monkeypatch.setitem(sys.modules, "kokoro_onnx", SimpleNamespace(Kokoro=ToneKokoro))
    ToneKokoro.created.clear()

    out = tmp_path / "out"
    load_fixture_script().main(str(models), str(manifest), str(out))

    payload = json.loads(capsys.readouterr().out)
    assert payload["providers"] == ["CPUExecutionProvider"]
    assert ort.preloads == 1
    assert ort.attempts == [["CUDAExecutionProvider", "CPUExecutionProvider"],
                            ["CPUExecutionProvider"]]
    assert payload["files"] == ["u1-0.pcm"]
    assert ToneKokoro.created == [("Hello there.", {"voice": "am_michael", "speed": 1.0, "lang": "en-us"})]
    pcm = out / "u1-0.pcm"
    assert pcm.is_file()
    # 2400 samples at 24 kHz -> 1600 at 16 kHz, trimmed of the zero crossings at both ends.
    assert 3000 <= pcm.stat().st_size <= 3200


def test_fixtures_report_cuda_when_the_session_really_loads(tmp_path, monkeypatch, capsys):
    models, manifest = one_segment_manifest(tmp_path)
    ort = RegisteredButBrokenOrt(cuda_loads=True)
    monkeypatch.setitem(sys.modules, "onnxruntime", ort)
    monkeypatch.setitem(sys.modules, "kokoro_onnx", SimpleNamespace(Kokoro=ToneKokoro))

    out = tmp_path / "out"
    load_fixture_script().main(str(models), str(manifest), str(out))

    payload = json.loads(capsys.readouterr().out)
    assert payload["providers"] == ["CUDAExecutionProvider", "CPUExecutionProvider"]
    assert ort.attempts == [["CUDAExecutionProvider", "CPUExecutionProvider"]]
    assert (out / "u1-0.pcm").is_file()


def test_cached_segments_are_not_synthesised_again(tmp_path, monkeypatch, capsys):
    models, manifest = one_segment_manifest(tmp_path)
    monkeypatch.setitem(sys.modules, "onnxruntime", RegisteredButBrokenOrt())
    monkeypatch.setitem(sys.modules, "kokoro_onnx", SimpleNamespace(Kokoro=ToneKokoro))
    ToneKokoro.created.clear()

    out = tmp_path / "out"
    script = load_fixture_script()
    script.main(str(models), str(manifest), str(out))
    capsys.readouterr()
    script.main(str(models), str(manifest), str(out))

    assert ToneKokoro.created == [("Hello there.", {"voice": "am_michael", "speed": 1.0, "lang": "en-us"})]
    assert json.loads(capsys.readouterr().out)["files"] == ["u1-0.pcm"]
