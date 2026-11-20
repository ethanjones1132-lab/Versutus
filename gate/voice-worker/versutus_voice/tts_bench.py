"""Compare Kokoro profiles in separate processes using only installed assets."""

import argparse
import contextlib
import json
import math
import os
import subprocess
import sys
import time
from pathlib import Path

from .audio import INPUT_SAMPLE_RATE
from .kokoro import TtsConfig, load_kokoro_speech

SENTENCES = {
    "short": "Yes, that should work.",
    "medium": "I would start with the simplest option first, and then check whether the result matches what you expected.",
    "long": (
        "The easiest way to see whether this is working is to start with a small example that you can repeat, "
        "check the result against what you expected to happen, and change one setting at a time until you know "
        "exactly which part is making the difference."
    ),
}
REPLY_FOLLOWUP = (
    "Use a small example that you can repeat so the result is easy to compare.",
    "If the result changes, write down which setting you changed before moving on.",
    "That way you will know which change to keep and which one to undo.",
)
LEGACY = {
    "chunkWords": 0, "intraThreads": 0, "graphOptimization": "all", "spinning": True, "warmup": "off",
}
TUNED = {"intraThreads": 4, "spinning": False}
CHUNKED = {"chunkWords": 8}
PROFILES = {
    "baseline": {},
    "default": {},
    "first-phrase": {},
    "primed": {"warmup": "startup"},
    "chunks": CHUNKED,
    "cpu-2": {**TUNED, "intraThreads": 2},
    "cpu-4": TUNED,
    "cpu-8": {**TUNED, "intraThreads": 8},
    "cpu-4-parallel": {**TUNED, "interThreads": 2},
    "cpu-4-extended": {**TUNED, "graphOptimization": "extended"},
    "cpu-4-no-arena": {**TUNED, "cpuArena": False, "memoryPattern": False},
    "cpu-4-chunks-primed": {**TUNED, **CHUNKED, "warmup": "startup"},
    "int8": {"model": "int8"},
    "int8-chunks-primed": {**TUNED, **CHUNKED, "model": "int8", "warmup": "startup"},
    "cuda": {"provider": "cuda"},
    "cuda-chunks-primed": {**TUNED, **CHUNKED, "provider": "cuda", "warmup": "startup"},
}
LEGACY_CHUNK_ALL = {"chunks", "cpu-4-chunks-primed", "int8-chunks-primed", "cuda-chunks-primed"}


def measure(speech, text):
    started = time.perf_counter()
    first_ms = head_ms = None
    audio_ms = underrun_ms = 0
    max_gap_ms = chunks = gaps = 0
    for _, pcm in speech.speak(text, gen=0):
        at_ms = (time.perf_counter() - started) * 1000
        if first_ms is None:
            first_ms = at_ms
        elif at_ms > head_ms:
            gap_ms = at_ms - head_ms
            underrun_ms += gap_ms
            max_gap_ms = max(max_gap_ms, gap_ms)
            gaps += 1
        duration_ms = len(pcm) / (2 * speech.sample_rate) * 1000
        head_ms = max(head_ms or 0, at_ms) + duration_ms
        audio_ms += duration_ms
        chunks += 1
    if first_ms is None:
        raise RuntimeError("no PCM")
    total_ms = (time.perf_counter() - started) * 1000
    return {
        "firstPcmMs": round(first_ms, 1), "totalMs": round(total_ms, 1),
        "audioMs": round(audio_ms, 1), "rtf": round(total_ms / audio_ms, 3),
        "estimatedUnderrunMs": round(underrun_ms, 1), "maxGapMs": round(max_gap_ms, 1),
        "gapCount": gaps, "chunks": chunks,
    }


def percentiles(rows):
    return {
        key: {f"p{p}": sorted(row[key] for row in rows)[math.ceil(len(rows) * p / 100) - 1]
              for p in (50, 90)}
        for key in rows[0]
    }


def measure_playback_replies(speech, repeats):
    # Use the worker's production order and PCM availability times, with all
    # text ready. Starting over at each sentence would hide cross-sentence gaps.
    replies = {length: " ".join((SENTENCES[length], *REPLY_FOLLOWUP)) for length in ("medium", "long")}
    samples = {length: [] for length in replies}
    for _ in range(repeats):
        for length, text in replies.items():
            samples[length].append(measure(speech, text))
    return {length: percentiles(rows) for length, rows in samples.items()}


def measure_after_idle(speech, config, repeats, idle_seconds):
    samples = {length: [] for length in SENTENCES}
    warmups = []
    for _ in range(repeats):
        for length, text in SENTENCES.items():
            time.sleep(idle_seconds)
            # Model call-open warmup ahead of speech when it would be queued by
            # the worker. Report its cost separately from the first-PCM timer.
            if config.should_prime_after_idle(speech):
                warmups.append({"ms": speech.prime()})
            samples[length].append({"firstPcmMs": measure(speech, text)["firstPcmMs"]})
    return {
        "idleSeconds": idle_seconds, "samplesPerLength": repeats, "callOpenWarmupCount": len(warmups),
        "callOpenWarmupMs": percentiles(warmups)["ms"] if warmups else None,
        **{length: percentiles(rows) for length, rows in samples.items()},
    }


def gpu_memory():
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.used,memory.total", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, check=True, timeout=5,
        )
        used, total = (int(x) for x in result.stdout.splitlines()[0].split(","))
        return {"usedMb": used, "totalMb": total}
    except (OSError, subprocess.SubprocessError, ValueError, IndexError):
        return None


def native_threads():
    """Total native threads (inclusive of the caller), not a Python thread count."""
    if sys.platform.startswith("linux"):
        try:
            return int(next(line.split()[1] for line in Path("/proc/self/status").read_text().splitlines()
                            if line.startswith("Threads:")))
        except (OSError, StopIteration, ValueError):
            return None
    if sys.platform != "win32":
        return None
    import ctypes
    from ctypes import wintypes

    class ThreadEntry(ctypes.Structure):
        _fields_ = [(name, wintypes.DWORD) for name in ("size", "usage", "tid", "pid", "priority", "delta", "flags")]

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    for api in (kernel.Thread32First, kernel.Thread32Next):
        api.argtypes = [wintypes.HANDLE, ctypes.POINTER(ThreadEntry)]
        api.restype = wintypes.BOOL
    handle = kernel.CreateToolhelp32Snapshot(0x00000004, 0)  # TH32CS_SNAPTHREAD
    if handle == ctypes.c_void_p(-1).value:
        return None
    try:
        entry = ThreadEntry()
        entry.size = ctypes.sizeof(entry)
        pid = os.getpid()
        count = 0
        found = kernel.Thread32First(handle, ctypes.byref(entry))
        while found:
            count += entry.pid == pid
            entry.size = ctypes.sizeof(entry)
            found = kernel.Thread32Next(handle, ctypes.byref(entry))
        return count or None
    finally:
        kernel.CloseHandle(handle)


def candidate_config(candidate, overrides):
    live = candidate in ("default", "custom", "first-phrase")
    base = {} if live else LEGACY
    return TtsConfig.from_mapping({**base, **PROFILES.get(candidate, {}), **overrides}, clamp_threads=live)


def benchmark(args, candidate):
    config = candidate_config(candidate, args.settings)
    # Keep the live model resident to check coexistence, not timing of a
    # simultaneous decode. The real call harness is still the contention test.
    whisper_device = None
    whisper = None  # keep this reference until all measurements complete
    if args.with_whisper:
        from .server import load_whisper, whisper_device as loaded_on, whisper_model_dir

        if whisper_model_dir(args.models_dir) is None:
            raise FileNotFoundError("--with-whisper needs the complete local Whisper model; run voice install")
        whisper = load_whisper(args.models_dir)
        import numpy as np

        segments, _ = whisper.transcribe(np.zeros(INPUT_SAMPLE_RATE, dtype=np.float32),
                                         language="en", beam_size=1, without_timestamps=True)
        list(segments)
        whisper_device = loaded_on()
        if whisper_device != "cuda":
            raise RuntimeError("--with-whisper requested CUDA coexistence, but Whisper fell back to CPU")

    gpu_before = gpu_memory() if args.with_whisper or config.provider == "cuda" else None
    threads_before = native_threads()
    started = time.perf_counter()
    chunk_all = candidate in LEGACY_CHUNK_ALL
    chunk_remainder = candidate != "first-phrase"
    speech = load_kokoro_speech(args.models_dir, config, chunk_all=chunk_all, chunk_remainder=chunk_remainder)
    load_ms = round((time.perf_counter() - started) * 1000, 1)
    chunking = "all-phrases" if chunk_all else "first-phrase+clauses" if chunk_remainder else "first-phrase"
    row = {
        "candidate": candidate, "coldLoadMs": load_ms, "whisperDevice": whisper_device,
        "logicalCpus": os.cpu_count(),
        "cpuThreads": {"intra": config.intraThreads or "ORT auto", "inter": config.interThreads,
                       "execution": "parallel" if config.interThreads > 1 else "sequential"},
        "nativeThreads": {"beforeKokoro": threads_before, "afterLoad": native_threads()},
        "profile": speech.synthesize.profile(),
        "chunking": chunking if config.chunkWords else "off",
    }
    if not row["profile"]["fallbacks"]:
        row["startupWarmupMs"] = speech.prime() if config.warmup != "off" else None
        row["firstSynthesis"] = measure(speech, SENTENCES["medium"])
        if not speech.synthesize.profile()["fallbacks"]:
            warm = {length: [] for length in SENTENCES}
            for _ in range(args.repeats):
                for length, text in SENTENCES.items():
                    warm[length].append(measure(speech, text))
            row["warm"] = {length: percentiles(samples) for length, samples in warm.items()}
            row["playback4Sentences"] = measure_playback_replies(speech, args.repeats)
            if args.idle_seconds:
                row["afterIdle"] = measure_after_idle(speech, config, args.repeats, args.idle_seconds)
    row["nativeThreads"]["afterSynthesis"] = native_threads()
    if args.with_whisper or config.provider == "cuda":
        row["gpuMemory"] = {"beforeKokoro": gpu_before, "afterSynthesis": gpu_memory()}
    row["profile"] = speech.synthesize.profile()
    if row["profile"]["fallbacks"]:
        for key in ("warm", "afterIdle", "playback4Sentences"):
            row.pop(key, None)
        row["status"] = "skipped (requested profile fell back)"
    return row


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--models-dir", required=True, type=Path)
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument("--candidate", choices=[*PROFILES, "custom"], action="append")
    parser.add_argument("--candidates", action="append", nargs="+", default=[],
                        help="only run these profiles (comma- or space-separated names)")
    overrides = parser.add_mutually_exclusive_group()
    overrides.add_argument("--settings", default={}, type=json.loads, help="JSON tts overrides (all candidates)")
    overrides.add_argument("--settings-file", type=Path, help="read tts overrides from a JSON file")
    parser.add_argument("--with-whisper", action="store_true")
    parser.add_argument("--idle-seconds", type=int, default=5,
                        help="pause before each afterIdle first-PCM sample (default: 5, 0 skips afterIdle)")
    parser.add_argument("--child", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.settings_file:
        try:
            args.settings = json.loads(args.settings_file.read_text(encoding="utf-8-sig"))
        except (OSError, ValueError) as error:
            parser.error(f"--settings-file: {error}")
    if args.repeats < 1 or args.idle_seconds < 0 or not isinstance(args.settings, dict):
        parser.error("--repeats must be positive, --idle-seconds nonnegative, and --settings a JSON object")
    candidates = dict.fromkeys([
        *(args.candidate or []),
        *(name.strip() for group in args.candidates for value in group for name in value.split(",")),
    ])
    for candidate in candidates:
        if candidate not in PROFILES and candidate != "custom":
            parser.error(f"unknown candidate: {candidate!r}; choose from {', '.join((*PROFILES, 'custom'))}")
    if args.child:
        if len(candidates) != 1:
            parser.error("--child requires one candidate")
        candidate = next(iter(candidates))
        try:
            with contextlib.redirect_stdout(sys.stderr):
                row = benchmark(args, candidate)
        except Exception as error:
            row = {"candidate": candidate, "status": "error", "error": str(error)[:500]}
        print(json.dumps(row))
        return int(row.get("status") == "error")

    failed = False
    for candidate in candidates or PROFILES:
        command = [sys.executable, "-m", "versutus_voice.tts_bench", "--child",
                   "--models-dir", str(args.models_dir), "--candidate", candidate,
                   "--repeats", str(args.repeats), "--settings", json.dumps(args.settings),
                   "--idle-seconds", str(args.idle_seconds)]
        if args.with_whisper:
            command.append("--with-whisper")
        child = subprocess.run(command, capture_output=True, text=True, encoding="utf-8",
                               env={**os.environ, "PYTHONIOENCODING": "utf-8"}, errors="replace")
        if child.stderr:
            print(child.stderr, file=sys.stderr, end="")
        if child.stdout.strip():
            print(child.stdout.strip(), flush=True)
        elif child.returncode:
            print(json.dumps({"candidate": candidate, "status": "error", "exit": child.returncode}), flush=True)
        failed |= child.returncode != 0
    return int(failed)


if __name__ == "__main__":
    sys.exit(main())
