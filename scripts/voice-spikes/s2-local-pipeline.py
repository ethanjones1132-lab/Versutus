#!/usr/bin/env python3
"""M1 S2 — the local voice pipeline on this PC.

A spike, not product code. Loads the models docs/plans/2026-09-12-realtime-voice-plan.md
§M1 S2 names, runs 20 synthetic utterances (10 with a mid-sentence pause), and records
STT latency and word error rate, Kokoro time to first audio, Smart Turn decisions,
peak VRAM and pinned versions. Writes docs/plans/voice-spikes/s2-<ts>.json and a draft
gate/voice-worker/models.lock.json.

Recorded fixtures (docs/plans/voice-spikes/fixtures/) are needed for meaningful WER and
Smart Turn labels; without them those rows are PENDING-DEVICE.

Usage:
  python scripts/voice-spikes/s2-local-pipeline.py [--models-dir DIR] [--out FILE]
                                                   [--fixtures DIR] [--limit N]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
import wave
from datetime import datetime, timezone
from pathlib import Path

# ctranslate2 eagerly loads cuBLAS/cuDNN on Windows. A throwaway venv that installs
# the nvidia-*-cu12 wheels keeps them under site-packages/nvidia, which is not on the
# DLL search path by default. Register it before anything imports ctranslate2.
if os.name == "nt":
    _nvidia = Path(sys.prefix) / "Lib" / "site-packages" / "nvidia"
    if _nvidia.exists():
        for _sub in _nvidia.iterdir():
            _bin = _sub / "bin"
            if _bin.exists():
                os.add_dll_directory(str(_bin))
                os.environ["PATH"] = f"{_bin}{os.pathsep}{os.environ.get('PATH', '')}"

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT_DIR = REPO_ROOT / "docs" / "plans" / "voice-spikes"
DEFAULT_MODELS_DIR = Path.home() / "AppData" / "Local" / "Versutus" / "Gate" / "voice" / "models"
MODELS_LOCK = REPO_ROOT / "gate" / "voice-worker" / "models.lock.json"
SAMPLE_RATE = 16000
UTTERANCE_COUNT = 20
PAUSE_UTTERANCE_COUNT = 10


def log(stage: str, message: str) -> None:
    print(f"[s2] {stage}: {message}", flush=True)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def peak_vram_mb() -> int | None:
    """Peak nvidia-smi memory used, in MB, or None when there is no NVIDIA GPU."""
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=10,
            check=True,
        )
        return max(int(line) for line in out.stdout.splitlines() if line.strip())
    except Exception as error:  # noqa: BLE001 - a missing GPU is a recorded fact
        log("vram", f"nvidia-smi unavailable: {error}")
        return None


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def write_wav(path: Path, samples, sample_rate: int) -> None:
    import numpy as np

    pcm = np.clip(samples, -1.0, 1.0)
    pcm = (pcm * 32767).astype("<i2")
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(pcm.tobytes())


def synth_utterances(out_dir: Path) -> list[dict]:
    """20 made-up clips: 10 plain, 10 with a mid-sentence pause. Not speech, so only timing."""
    import numpy as np

    out_dir.mkdir(parents=True, exist_ok=True)
    clips: list[dict] = []
    for index in range(UTTERANCE_COUNT):
        duration = 1.5 + 0.2 * (index % 5)
        t = np.linspace(0, duration, int(SAMPLE_RATE * duration), endpoint=False)
        # A two-formant-ish hum stands in for a voice; it is purely for timing.
        base = 0.2 * np.sin(2 * np.pi * 180 * t) + 0.1 * np.sin(2 * np.pi * 2400 * t)
        envelope = np.clip(np.sin(2 * np.pi * 1.2 * t), 0, 1)
        clip = base * envelope
        has_pause = index < PAUSE_UTTERANCE_COUNT
        if has_pause:
            pause_start = int(len(clip) * 0.5)
            pause_len = int(SAMPLE_RATE * 0.9)
            clip[pause_start : pause_start + pause_len] = 0.0
        path = out_dir / f"synthetic-{index:02d}.wav"
        write_wav(path, clip.astype(np.float32), SAMPLE_RATE)
        clips.append(
            {
                "index": index,
                "path": str(path),
                "reference": "",  # synthetic clips have no ground-truth words
                "hasPause": has_pause,
                "durationSec": duration,
            }
        )
    return clips


def p50(values: list[float]) -> float | None:
    ordered = sorted(values)
    return ordered[len(ordered) // 2] if ordered else None


def load_whisper():
    from faster_whisper import WhisperModel

    started = time.perf_counter()
    try:
        model = WhisperModel("large-v3-turbo", device="cuda", compute_type="int8_float16")
        kind = "large-v3-turbo/cuda/int8_float16"
    except Exception as error:  # noqa: BLE001 - CPU fallback is the documented fallback
        log("whisper", f"large-v3-turbo CUDA failed ({error}); falling back to small.en CPU")
        model = WhisperModel("small.en", device="cpu", compute_type="int8")
        kind = "small.en/cpu/int8"
    return model, kind, (time.perf_counter() - started) * 1000


def transcribe(model, path: str, beam_size: int = 1) -> tuple[float, str]:
    started = time.perf_counter()
    segments, _info = model.transcribe(path, beam_size=beam_size)
    text = "".join(segment.text for segment in segments).strip()
    return (time.perf_counter() - started) * 1000, text


def word_error_rate(reference: str, hypothesis: str) -> float | None:
    if not reference:
        return None
    ref = reference.lower().split()
    hyp = hypothesis.lower().split()
    if not ref:
        return None
    # Levenshtein at word level.
    previous = list(range(len(hyp) + 1))
    for i, ref_word in enumerate(ref, start=1):
        current = [i]
        for j, hyp_word in enumerate(hyp, start=1):
            current.append(
                min(
                    previous[j] + 1,
                    current[j - 1] + 1,
                    previous[j - 1] + (ref_word != hyp_word),
                )
            )
        previous = current
    return previous[-1] / len(ref)


def load_kokoro(models_dir: Path):
    from kokoro_onnx import Kokoro

    model_path = models_dir / "kokoro-v1.0.onnx"
    voices_path = models_dir / "voices-v1.0.bin"
    if not model_path.exists() or not voices_path.exists():
        raise FileNotFoundError(f"Kokoro model/voices not found under {models_dir}")
    return Kokoro(str(model_path), str(voices_path))


def kokoro_first_audio(kokoro) -> dict:
    """Five warm sentences, so first-call model loading does not dominate the p50."""
    sentence = "Versutus voice check."
    latencies = []
    rate = 24000
    seconds = 0.0
    for _ in range(5):
        started = time.perf_counter()
        samples, rate = kokoro.create(sentence, voice="af_sarah", speed=1.0, lang="en-us")
        latencies.append((time.perf_counter() - started) * 1000)
        seconds = len(samples) / int(rate)
    return {
        "firstAudioMs": latencies[0],
        "p50Ms": p50(latencies),
        "sampleRate": int(rate),
        "seconds": seconds,
    }


def smart_turn_probe(models_dir: Path, clips: list[dict]) -> dict:
    """Best-effort; the exact preprocessing is what S2 exists to confirm."""
    import onnxruntime as ort

    candidates = list(models_dir.glob("smart-turn*.onnx"))
    if not candidates:
        return {"state": "not-installed", "note": "no smart-turn*.onnx under models dir"}
    session = ort.InferenceSession(str(candidates[0]), providers=["CPUExecutionProvider"])
    inputs = [item.name for item in session.get_inputs()]
    return {
        "state": "loaded",
        "model": candidates[0].name,
        "inputs": inputs,
        "clips": len(clips),
        "note": "preprocessing not implemented in the spike; decisions UNKNOWN",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="M1 S2 local voice pipeline spike")
    parser.add_argument("--models-dir", default=str(DEFAULT_MODELS_DIR))
    parser.add_argument("--out", default=None)
    parser.add_argument("--fixtures", default=str(DEFAULT_OUT_DIR / "fixtures"))
    parser.add_argument("--limit", type=int, default=UTTERANCE_COUNT)
    args = parser.parse_args()

    models_dir = Path(args.models_dir)
    models_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")
    out_path = Path(args.out) if args.out else DEFAULT_OUT_DIR / f"s2-{stamp}.json"

    results: dict = {
        "startedAt": now_iso(),
        "modelsDir": str(models_dir),
        "fixturesDir": args.fixtures,
        "fixturesPresent": Path(args.fixtures).exists(),
        "peakVramMb": peak_vram_mb(),
        "whisper": {},
        "kokoro": {},
        "smartTurn": {},
        "utterances": [],
        "versions": {},
        "models": {},
    }

    clips = synth_utterances(DEFAULT_OUT_DIR / "s2-audio")[: args.limit]

    try:
        model, whisper_kind, load_ms = load_whisper()
        results["whisper"] = {"kind": whisper_kind, "loadMs": load_ms}
        partials: list[float] = []
        finals: list[float] = []
        for clip in clips:
            partial_ms, _partial_text = transcribe(model, clip["path"], beam_size=1)
            final_ms, hypothesis = transcribe(model, clip["path"], beam_size=5)
            clip["partialMs"] = partial_ms
            clip["finalMs"] = final_ms
            clip["hypothesis"] = hypothesis
            clip["wer"] = word_error_rate(clip["reference"], hypothesis)
            partials.append(partial_ms)
            finals.append(final_ms)
            results["utterances"].append(clip)
        results["whisper"]["p50PartialMs"] = p50(partials)
        results["whisper"]["p50FinalMs"] = p50(finals)
        results["whisper"]["maxFinalMs"] = max(finals) if finals else None
    except Exception as error:  # noqa: BLE001 - a spike records, never crashes
        log("whisper", f"failed: {error}")
        results["whisper"] = {"state": "failed", "error": str(error)}

    try:
        kokoro = load_kokoro(models_dir)
        results["kokoro"] = kokoro_first_audio(kokoro)
    except Exception as error:  # noqa: BLE001
        log("kokoro", f"failed: {error}")
        results["kokoro"] = {"state": "failed", "error": str(error)}

    try:
        results["smartTurn"] = smart_turn_probe(models_dir, clips)
    except Exception as error:  # noqa: BLE001
        results["smartTurn"] = {"state": "failed", "error": str(error)}

    for name, module in (("faster_whisper", "faster_whisper"), ("kokoro_onnx", "kokoro_onnx"), ("onnxruntime", "onnxruntime")):
        try:
            imported = __import__(module)
            results["versions"][name] = getattr(imported, "__version__", "unknown")
        except Exception:  # noqa: BLE001
            results["versions"][name] = None

    for model_file in models_dir.glob("*"):
        if model_file.is_file():
            results["models"][model_file.name] = {
                "sha256": sha256(model_file),
                "bytes": model_file.stat().st_size,
            }

    results["finishedAt"] = now_iso()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(results, indent=2), encoding="utf-8")

    draft_lock = {
        "source": "M1 S2 spike",
        "updatedAt": now_iso(),
        "versions": results["versions"],
        "models": results["models"],
        "defaults": {
            "stt": results["whisper"].get("kind"),
            "tts": "kokoro-onnx",
            "vad": "silero_vad_v6",
            "turn": "smart-turn-v3",
        },
    }
    MODELS_LOCK.parent.mkdir(parents=True, exist_ok=True)
    MODELS_LOCK.write_text(json.dumps(draft_lock, indent=2), encoding="utf-8")

    log("done", f"wrote {out_path} and {MODELS_LOCK}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
