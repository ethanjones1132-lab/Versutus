"""Kokoro profiles shared by the live worker, doctor and benchmark."""

import json
import os
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np

from .audio import OUTPUT_SAMPLE_RATE, float32_to_pcm16, resample_linear
from .tts import SpeechSynthesizer

MODELS = {"full": "kokoro-v1.0.onnx", "int8": "kokoro-v1.0.int8.onnx"}
PROVIDERS = {"cpu": "CPUExecutionProvider", "cuda": "CUDAExecutionProvider"}
CUDA_ARENA_BYTES = 1536 * 1024**2


def default_intra_threads():
    """Use at most half the logical CPUs and leave room for VAD and Whisper."""
    return max(1, min(4, (os.cpu_count() or 1) // 2))


@dataclass(frozen=True)
class TtsConfig:
    model: str = "full"
    provider: str = "auto"
    voice: str = "af_sarah"
    chunkWords: int = 8
    warmup: str = "idle"  # off, startup only, or startup + idle call-open
    idleSeconds: int = 120
    intraThreads: int = field(default_factory=default_intra_threads)
    interThreads: int = 1  # >1 enables parallel executor
    graphOptimization: str = "extended"
    cpuArena: bool = True
    memoryPattern: bool = True
    spinning: bool = False
    gpuMemLimit: int = CUDA_ARENA_BYTES  # bytes in the CUDA EP allocator arena

    def should_prime_after_idle(self, speech):
        return self.warmup == "idle" and speech.clock() - speech.last_used >= self.idleSeconds

    @classmethod
    def from_mapping(cls, raw, *, clamp_threads=True):
        defaults = cls()
        if not isinstance(raw, dict):
            return defaults
        valid = {
            "model": lambda x: x in MODELS,
            "provider": lambda x: x == "auto" or x in PROVIDERS,
            "voice": lambda x: x.isascii() and x.replace("_", "").isalnum() and len(x) <= 64,
            "chunkWords": lambda x: x == 0 or 6 <= x <= 10,
            "warmup": lambda x: x in ("off", "startup", "idle"),
            "idleSeconds": lambda x: 1 <= x <= 86400,
            "intraThreads": lambda x: 0 <= x <= 64,
            "interThreads": lambda x: 1 <= x <= 16,
            "graphOptimization": lambda x: x in ("off", "basic", "extended", "all"),
            "gpuMemLimit": lambda x: 0 < x < 2**53,
        }
        settings = {
            key: raw[key] for key, default in asdict(defaults).items()
            if type(raw.get(key)) is type(default) and (key not in valid or valid[key](raw[key]))
        }
        if clamp_threads and "intraThreads" in settings:
            # Old voice.json files can still say 0 (ORT auto). In live calls
            # that now means the adaptive cap, not an unrestricted pool.
            settings["intraThreads"] = min(settings["intraThreads"] or defaults.intraThreads, defaults.intraThreads)
        return cls(**settings)


def read_tts_config(models_dir):
    try:
        raw = json.loads((Path(models_dir).parent / "voice.json").read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return TtsConfig()
    return TtsConfig.from_mapping(raw.get("tts") if isinstance(raw, dict) else None)


def session_options(config, ort):
    options = ort.SessionOptions()
    options.intra_op_num_threads = config.intraThreads
    options.inter_op_num_threads = config.interThreads
    options.execution_mode = (
        ort.ExecutionMode.ORT_PARALLEL if config.interThreads > 1 else ort.ExecutionMode.ORT_SEQUENTIAL
    )
    options.graph_optimization_level = getattr(ort.GraphOptimizationLevel, {
        "off": "ORT_DISABLE_ALL", "basic": "ORT_ENABLE_BASIC",
        "extended": "ORT_ENABLE_EXTENDED", "all": "ORT_ENABLE_ALL",
    }[config.graphOptimization])
    options.enable_cpu_mem_arena = config.cpuArena
    options.enable_mem_pattern = config.memoryPattern
    if not config.spinning:
        options.add_session_config_entry("session.intra_op.allow_spinning", "0")
        options.add_session_config_entry("session.inter_op.allow_spinning", "0")
    return options


class KokoroSynthesizer:
    def __init__(self, kokoro, config, active, cpu_fallback=None, on_profile_change=None):
        self._kokoro = kokoro
        self._config = config
        self._active = active
        self._cpu_fallback = cpu_fallback
        self._on_profile_change = on_profile_change

    def profile(self):
        return {"requested": asdict(self._config), **self._active}

    def enable_cpu_fallback(self, build_cpu):
        self._cpu_fallback = build_cpu

    def _pcm(self, phrase):
        samples, rate = self._kokoro.create(phrase, voice=self._config.voice, speed=1.0, lang="en-us")
        if not len(samples) or not np.isfinite(samples).all():
            raise RuntimeError("Kokoro produced empty or non-finite audio")
        if int(rate) != OUTPUT_SAMPLE_RATE:
            samples = resample_linear(samples, int(rate), OUTPUT_SAMPLE_RATE)
        return float32_to_pcm16(samples)

    def __call__(self, phrase):
        try:
            return [self._pcm(phrase)]
        except ValueError:
            # Bad text (e.g. no phonemes) or an unknown voice isn't a provider failure.
            raise
        except Exception as error:
            if self._cpu_fallback is None:
                raise
            # Only this phrase is retried; previously emitted PCM stays on the wire.
            self._kokoro, self._active = self._cpu_fallback()
            self._cpu_fallback = None
            self._active["fallbacks"].append(f"first model inference failed: {type(error).__name__}")
            if self._on_profile_change is not None:
                self._on_profile_change(self.profile())
            return [self._pcm(phrase)]


def load_kokoro_speech(models_dir, config=None, *, ort=None, kokoro_cls=None, chunk_all=False,
                       chunk_remainder=True, on_profile_change=None):
    """Select a local graph/provider; never download on the call path."""
    models_dir = Path(models_dir)
    config = config or read_tts_config(models_dir)
    full = models_dir / MODELS["full"]
    voices = models_dir / "voices-v1.0.bin"
    if not full.is_file() or not voices.is_file():
        raise FileNotFoundError(f"Kokoro model/voices not found under {models_dir}")
    if ort is None:
        import onnxruntime as ort
    if kokoro_cls is None:
        from kokoro_onnx import Kokoro as kokoro_cls

    model = config.model
    provider = config.provider
    fallbacks = []
    if model != "full" and not (models_dir / MODELS[model]).is_file():
        fallbacks.append(f"{MODELS[model]} missing; run voice install --tts-int8")
        model, provider = "full", "cpu"
    if provider == "auto":
        provider = "cuda"
    if provider == "cuda" and PROVIDERS["cuda"] not in ort.get_available_providers():
        fallbacks.append("CUDAExecutionProvider unavailable")
        provider = "cpu"

    def build(model, provider):
        ep = PROVIDERS[provider]
        providers = [ep]
        if provider == "cuda":
            providers = [(ep, {
                "arena_extend_strategy": "kSameAsRequested",
                "gpu_mem_limit": config.gpuMemLimit,
                # Avoid exhaustive convolution searches (and their workspace)
                # on the first inference for a new phrase length.
                "cudnn_conv_algo_search": "HEURISTIC",
            }), PROVIDERS["cpu"]]
        filename = MODELS[model]
        session = ort.InferenceSession(str(models_dir / filename), sess_options=session_options(config, ort),
                                       providers=providers)
        active_providers = session.get_providers()
        if not active_providers or active_providers[0] != ep:
            raise RuntimeError(f"{ep} did not initialize")
        # ORT can otherwise silently change the provider after an inference
        # failure; we retry explicitly so diagnostics report the actual choice.
        session.disable_fallback()
        return kokoro_cls.from_session(session, str(voices)), {
            "model": filename, "providers": active_providers, "fallbacks": list(fallbacks),
        }

    def build_cpu():
        return build("full", "cpu")

    def adapter(kokoro, active, fallback=None):
        synth = KokoroSynthesizer(kokoro, config, active, fallback, on_profile_change)
        return SpeechSynthesizer(synth, chunk_words=config.chunkWords, chunk_all=chunk_all,
                                 chunk_remainder=chunk_remainder)

    stage = "load"
    try:
        if provider == "cuda":
            # Prefer pip's CUDA 13 libraries for ORT. Whisper has already
            # registered its separate CUDA 12 libraries in the live worker.
            ort.preload_dlls(directory="")
        kokoro, active = build(model, provider)
        fallback = build_cpu if (model, provider) != ("full", "cpu") else None
        if config.provider == "auto" and provider == "cuda":
            # Validate via the actual PCM/chunk path, without a hidden fallback
            # during the test. This also pays for the scheduled startup prime.
            speech = adapter(kokoro, active)
            stage = "warm-up"
            speech.startup_warmup_ms = speech.prime()
            speech.synthesize.enable_cpu_fallback(fallback)
            return speech
        return adapter(kokoro, active, fallback)
    except Exception as error:
        if (model, provider) == ("full", "cpu"):
            raise

        detail = " ".join(str(error).split())[:200]
        fallbacks.append(f"{model}/{provider} {stage} failed: {type(error).__name__}"
                         + (f" ({detail})" if detail else ""))
        if stage == "warm-up":
            # Drop the failed CUDA session before creating the CPU replacement.
            del speech, kokoro
    return adapter(*build_cpu())


def last_tts_latency(models_dir, config):
    try:
        sample = json.loads((Path(models_dir).parent / "tts-latency.json").read_text(encoding="utf-8"))
        if (sample["profile"]["requested"] == asdict(config)
                and sample["profile"]["model"] in MODELS.values()
                and isinstance(sample["profile"]["providers"], list)
                and all(p in PROVIDERS.values() for p in sample["profile"]["providers"])
                and type(sample["measuredAtUnixMs"]) is int and 0 < sample["measuredAtUnixMs"] < 8640000000000000
                and type(sample["synthToFirstPcmMs"]) is int and sample["synthToFirstPcmMs"] >= 0):
            return sample
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return None


def record_tts_latency(models_dir, profile, synth_ms):
    """One best-effort scalar snapshot, written after sending PCM, never text or audio."""
    _record_snapshot(models_dir, "tts-latency.json", {
        "profile": profile, "synthToFirstPcmMs": synth_ms, "measuredAtUnixMs": round(time.time() * 1000),
    })


def record_tts_profile(models_dir, profile):
    """Publish the worker's provider at startup and when it changes."""
    _record_snapshot(models_dir, "tts-profile.json", {"pid": os.getpid(), "profile": profile})


def _record_snapshot(models_dir, filename, value):
    path = Path(models_dir).parent / filename
    pending = path.with_suffix(f".{os.getpid()}.tmp")
    try:
        pending.write_text(json.dumps(value), encoding="utf-8")
        pending.replace(path)
    except OSError:
        # The worker may have no permission to remove the temporary file either.
        try:
            pending.unlink(missing_ok=True)
        except OSError:
            pass
