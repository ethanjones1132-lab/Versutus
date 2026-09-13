# S2 findings — local voice pipeline on this PC (M1, 2026-09-13)

Capture: `s2-2026-09-13T06-55-46Z.json`. Host: Windows 11, i5-14400F, RTX 4060 8 GB,
16 GB RAM. Throwaway venv: Python 3.12.13 via `uv`, `faster-whisper 1.2.1`,
`ctranslate2 4.8.2`, `kokoro-onnx 0.6.1`, `onnxruntime 1.30.0`, `numpy 2.5.3`.
Models: faster-whisper `large-v3-turbo` (CUDA, `int8_float16`); Kokoro
`kokoro-v1.0.onnx` + `voices-v1.0.bin` (from `thewh1teagle/kokoro-onnx`
`model-files-v1.0`). Draft lock: `gate/voice-worker/models.lock.json`.

`docs/plans/voice-spikes/fixtures/` does not exist, so every recording-dependent
row (word error rate, Smart Turn labels, thinking-pause acceptance) is
**PENDING-DEVICE**. Timing below is on 20 synthetic non-speech hum clips
(10 plain, 10 with a 0.9 s mid-clip pause), 1.5–2.3 s each.

## Pass criteria

| Criterion | Target | Measured | Verdict |
|---|---|---|---|
| Whisper final latency p50 (≤5 s utterances) | ≤ 400 ms | **424 ms** final (beam 5); partial (beam 1) 408 ms | **FAIL (near miss, +6%)** |
| Kokoro first sentence p50, CPU or GPU | ≤ 300 ms | **476 ms** p50 on CPU (first call 657 ms) | **FAIL** |
| Smart Turn holds ≥ 8/10 thinking pauses, ≤400 ms added delay | 8/10 | model not installed | PENDING-DEVICE |
| Peak VRAM while a call is live | ≤ 3 GB | **1070 MB** | **PASS** |

Also measured: `large-v3-turbo` CUDA load 4.6 s; max final 452 ms across 20 clips.

## Notes and interpretation

- The GPU path works: `ctranslate2` loads `cublas64_12.dll` / `cudnn64_9.dll` only
  when the `nvidia-cublas-cu12` + `nvidia-cudnn-cu12` wheels are installed and their
  `bin` dirs are registered (`os.add_dll_directory`). A plain venv without them fails
  even for `device="cpu"` because the extension loads cuBLAS eagerly on Windows.
- Whisper at ~420 ms p50 is a near miss on synthetic hums; real speech and the
  tuned partial/final split (M6) may move it either way. It is close enough that
  `large-v3-turbo` on GPU stays the default (decision 4) rather than dropping to
  `small.en`.
- Kokoro on CPU is ~1.6× over the target. Options for M5, in order: (a) run Kokoro
  on `onnxruntime-gpu`, (b) pre-warm the session at Gate start so the first call
  is not the slow one, (c) accept and re-tune the target with S2 numbers. The
  spike measured CPU only (the plan's stated default); GPU was not installed here.
- Smart Turn v3 was not downloaded or run; its input window and rate remain
  unconfirmed, so that fixture row is open for M5.
- `kokoro-onnx` exposes no `__version__`; the lock records the PyPI version by name.

## Recommendation

- Keep `large-v3-turbo` on CUDA/`int8_float16`; budget ≈1.1 GB VRAM, comfortably
  under the 3 GB cap.
- Install Smart Turn and the recorded fixtures, then re-measure the rows above
  before M5 freezes the thresholds.
- Try Kokoro on `onnxruntime-gpu` (and/or warm start) in M5; CPU p50 476 ms does
  not meet the 300 ms target.

## Repro

```
uv venv --python 3.12 <venv>
uv pip install --python <venv>\\Scripts\\python.exe faster-whisper kokoro-onnx onnxruntime soundfile numpy nvidia-cublas-cu12 nvidia-cudnn-cu12
<venv>\\Scripts\\python.exe scripts/voice-spikes/s2-local-pipeline.py
```
