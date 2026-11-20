# Measuring Kokoro first audio

From the repo root, using the Gate's installed voice venv and local models:

```powershell
npm run voice:tts-bench -- --with-whisper --candidates default cpu cuda
```

This does not install anything or write to the Gate home. Each candidate gets a
new Python process and ONNX session. A cold session does not imply a cold
filesystem cache. The benchmark emits one JSON row per candidate: session load
time, startup warm-up time (if enabled), the first medium sentence after load
or priming, and p50/p90 for warm short, medium and long sentences. `afterIdle`
repeats the first-PCM measurement for all three lengths, pausing before every
sample (5 seconds by default). If the pause reaches the profile's call-open
warm-up threshold, the benchmark runs that warm-up before timing first PCM
and reports its count and p50/p90 cost separately. To exercise the default
120-second threshold, run the following (each repeat waits three times):

```powershell
npm run voice:tts-bench -- --with-whisper --candidates default --idle-seconds 120 --repeats 5
```

Compare **first PCM** for onset and **total synthesis time / audio duration
(RTF)** for throughput. For individual sentences, read `warm.medium.maxGapMs.p90`
and `warm.long.maxGapMs.p90` (target: both under 300 ms). `playback4Sentences`
repeats the same four-sentence reply with either a medium or long opening, all
text ready. Read `playback4Sentences.medium.maxGapMs.p90` and
`playback4Sentences.long.maxGapMs.p90` for the longest gaps across the reply.
Both report first PCM, total underrun, longest gap and gap count at p50/p90.
The gaps exclude waiting for the first PCM. The simulation plays at real time
as PCM becomes available; it does not model the Bot's text delivery, network
or AudioTrack jitter. Thread counts show the configured ONNX
intra- and inter-op sizes and the process's native thread counts on Windows/Linux.

`baseline` reproduces the original ORT-auto, spinning, unprimed benchmark.
`first-phrase` uses the round-2 chunking schedule (first cut only). `default`
uses the live `auto` profile below; `cpu` and `cuda` use the same profile
with only the provider forced. To isolate the historical CPU throughput change, add
`cpu-4-extended` to `--candidates`. Without a filter, all historical
candidates are included; the older `chunks` variants still chunk throughout
for comparison. `--candidate` remains repeatable; `--repeats` controls samples
per length, and `--idle-seconds 0` skips `afterIdle`.

`--candidate custom --settings '{"chunkWords":6,"intraThreads":2}'`
tests a configurable live profile. On shells that strip quotes from program
arguments, pass the absolute path to a file containing that JSON object with
`--settings-file`. The benchmark uses its own profiles, not `voice.json`.
Add `--with-whisper` to keep the warmed local Whisper model resident
on CUDA and report VRAM before/after Kokoro; it does not perform simultaneous
decodes. A missing requested graph, an explicit `cuda` candidate that falls
back, or a provider switch during a measurement is reported as skipped.
`default` can measure its startup CPU fallback and records why it chose CPU.

## Measured provider comparison

Ethan's RTX 4060 (8 GB, 16 logical CPUs), with warmed Whisper on CUDA in
the same process. This is the pre-rollout comparison; the `default cpu cuda`
command above remeasures with the shipping profile and CUDA arena settings.

| Warm metric | CPU default (previous release) | int8 on CPU | CUDA |
|---|---:|---:|---:|
| First PCM short / medium / long p50 (ms) | 547 / 828 / 727 | 5441 / 8073 / 6959 | **183 / 220 / 211** |
| RTF p50 | 0.38–0.43 | 3.6 | **0.11–0.15** |
| Four-sentence reply max gap p90 | 0 | 10 s | 0 |
| First PCM after 5 s idle (ms) | 541–804 | ~5400–7900 | 321–422 |
| VRAM added by Kokoro | 0 | 0 | ~1 GB (5.1 → 6.2 GB of 8.2) |

The CPU and CUDA audio for the same sentence had equal length and 0.98
correlation, and Whisper transcribed both identically despite the ORT Memcpy
and ScatterND warnings. int8 was slower and remains opt-in.

## Live default and overrides

The built-in profile uses the full-precision graph with `af_sarah` and
`provider: "auto"`. It selects CUDA only if ORT advertises it and Kokoro can
build the session and synthesize the warm-up to PCM. Otherwise it records the
reason and runs on tuned CPU. Explicit `cpu` bypasses CUDA; explicit `cuda`
requests CUDA with the existing CPU fallback if it cannot run.

The CPU profile uses intra-op
`max(1, min(4, logical CPUs // 2))`, inter-op 1 (sequential), spinning off,
extended graph optimization, and both the CPU arena and memory pattern on.
On the measured PC, the unprimed four-thread extended candidate had a 0.76
medium-sentence RTF versus 2.07 for the old benchmark baseline.

CUDA uses `kSameAsRequested` to avoid power-of-two arena growth and
`HEURISTIC` cuDNN convolution selection to avoid exhaustive searches and their
workspace on first use of new phrase shapes. `tts.gpuMemLimit` is the CUDA EP
arena limit in bytes (default `1610612736`, 1.5 GiB) to leave room for Whisper.
It is not a cap on total GPU memory, including allocations outside that arena.

`chunkWords: 8` leaves the first-phrase rule unchanged: cut at the first
natural pause between words 6 and 8, or at the eighth complete word. A short
first sentence is left whole. For sentences over 16 words (including any
opening already sent by Gate), the worker then plans clause-sized pieces with
an estimated 3.2 words/s and RTF 0.90:

- Start with the estimated duration of the opening as unplayed audio. A
  longer later sentence without a known opening starts with a capped
  `chunkWords` piece, preferring a pause within the last two words of that
  budget. It does not assume any time left over from the preceding sentence.
- The next word budget is
  `floor((unplayedSeconds - 0.45 - 0.05) * wordsPerSecond / RTF)`, normally
  clamped to 3–16 words. The 450 ms is a safety margin; the 50 ms is a
  per-inference overhead estimate. Subtract the next piece's estimated
  synthesis time (`RTF * duration + 0.05`) before adding its audio duration.
  With synthesis faster than playback, the budget can grow as audio builds up.
- Within budget, prefer the last punctuation pause (comma, semicolon, colon,
  dash), then a cut before a conjunction; otherwise cut at a whole word.
  Leave at least 3 words on either side rather than stranding a tiny tail.

This is an estimate, not a guarantee against slower inference, text-arrival
delays or unusually fast speech. PCM is handed off immediately as each piece
renders; the worker never waits for playback, and the Gate adds no silence.

To override the profile, merge a `tts` object into `<gate home>/voice/voice.json`
and restart the Gate. `chunkWords` accepts 6–10, or `0` to disable chunking.
`intraThreads` can lower the live thread count; larger values are clamped and
old `0` values use the adaptive cap. `interThreads` greater than 1 selects
parallel execution. Other overrides include `spinning`, `graphOptimization`
(`off`, `basic`, `extended`, `all`), `cpuArena` and `memoryPattern`.
`warmup` can be `off`, `startup`, or `idle` (default: startup plus call-open
after `idleSeconds`, 120 by default). Warm-up uses the live voice and PCM path.
`auto` still validates CUDA when `warmup` is `off`; a successful validation
also serves as startup warm-up so it isn't repeated.
Call-open warm-up is queued without delaying mic acknowledgment; pending work
yields to real speech, but an inference already running cannot be preempted.

To fetch only the opt-in graph on a machine that already has the venv:

```powershell
node gate/cli.mjs voice doctor --tts-int8
```

`node gate/cli.mjs voice install --tts-int8` includes it in a full install.
Neither command activates it. Set `tts.model` to `int8` to use it in calls.
The [official Kokoro-ONNX model-files-v1.1 release](https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.1)
publishes the English `kokoro-v1.0.int8.onnx` (114,119,327 bytes) with [SHA-256
metadata](https://api.github.com/repos/thewh1teagle/kokoro-onnx/releases/assets/520133701):
`ae315a79b623f244700e4afb9246c46a26066782e049ba174bf3ba433970ee9c`.
It uses the already-installed `voices-v1.0.bin`.

Run `node gate/cli.mjs voice doctor` for the installed ORT distribution, the
provider and fallbacks from its own synthesis probe and any live worker, and
the last live first-PCM measurement for the same settings. `node gate/cli.mjs voice status` reports
the installed ORT distribution and the live worker's provider and fallbacks;
`tts` is `null` if no live worker has reported a profile. Status doesn't load
a model. Only diagnostics and timing scalars are saved, not speech or PCM.
`voice.tts` names the speak job and its sentence ordinal. `workerQueueMs` is
the time on the worker before it started that sentence, `synthToPcmMs` ends at
the first rendered PCM, and `pcmToSendMs` measures Gate arrival to the first
frame handed to the live socket (including pacing). Null send timings mean the
frame was not handed to a live socket at playout. An early opening delivered
before a sentence is complete is its own speak job.

Finally, compare first reply text → first PCM in the Codex live harness.
The micro-benchmark does not establish the F1 bar: F1 also includes
speech endpointing, transcription/commit and phone playback.

## Voice venv and lock

The standard lock selects `onnxruntime-gpu` with CUDA 13/cuDNN on Windows
and Linux, alongside Whisper's CUDA 12 libraries. On macOS it selects the
CPU `onnxruntime` wheel. Both wheels provide the CPU execution provider.
`voice install --cpu` applies the same platform lock and creates
`<gate home>/voice/force-cpu`, forcing both Whisper and Kokoro to CPU at runtime
even if `tts.provider` says otherwise. Restart the Gate after changing this
mode; remove the marker and restart to allow CUDA again. A regular reinstall
leaves the marker alone. The Python worker also accepts `--cpu` directly.

Stop the Gate and any voice worker before upgrading the venv (especially on
Windows, where a loaded DLL may be locked). On Windows/Linux, if CPU ORT is
installed, `voice install` uninstalls both ORT distributions before applying
the lock, so the GPU wheel restores every shared file. Subsequent installs
leave a healthy GPU wheel in place. Don't install both distributions into
the same venv. `voice doctor` and `voice status` flag that conflict with a
repair hint.

Regenerate from the repo root, using the existing lock as the pin baseline
(no `--upgrade`). This command also appears in the regenerated lock header:

```powershell
uv pip compile --universal --python-version 3.12 --override gate/voice-worker/overrides.txt --constraint gate/voice-worker/cuda-constraints.txt gate/voice-worker/requirements.in -o gate/voice-worker/requirements.lock
```

`--universal` keeps the platform split. The ORT override limits transitive
CPU-wheel requests from `kokoro-onnx` and `faster-whisper` to macOS. Install
applies the resulting pins with `uv pip install --no-deps -r requirements.lock`
so those dependencies aren't re-resolved into the environment again.
