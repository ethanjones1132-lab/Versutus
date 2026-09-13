# Voice spikes — decisions (M1, 2026-09-13)

Inputs: `s1-findings.md`, `s2-findings.md`, captures
`s1-2026-09-13T06-31-13-883Z.jsonl`, `s2-2026-09-13T06-55-46Z.json`. These decisions
replace the open questions in `docs/plans/2026-09-12-realtime-voice-plan.md` §4.7/§4.6.

## Codex engine — **neither** (do not ship a Codex voice)

`codex-cli 0.147.0` app-server realtime does not run on this PC's ChatGPT login
(`~/.codex/auth.json` `auth_mode: chatgpt`). With
`-c features.realtime_conversation=true`, `thread/realtime/start` resolves but the
conversation is never prepared: `thread/realtime/error` →
`"realtime conversation requires API key auth"`. Without the flag the thread does not
support realtime at all. No `thread/realtime/started` was observed. `listVoices`
works and returns the v1/v2 voice sets, but nothing else about S1 could be measured.

Per §10 decision 3, a Codex voice that cannot be proven to voice the Bot is not
shipped. Consequences:

- M3 (ChatGPT via Codex) is **not buildable as written**; do not implement the relay
  or speech sub-modes.
- The M3 capability probe (task 3.4) reduces to reporting `unavailable` with the
  reason above; the Settings row for "ChatGPT subscription (via Codex)" is disabled,
  like the Grok row.
- The Gate-provider flagship is the **`local`** engine (M5); `phone` (Phase 0) stays
  the fallback. `auto` order becomes `local` → `phone`.

Open risk: a future codex-cli that accepts the ChatGPT login for app-server realtime
would reopen M3; the engine interface keeps it a drop-in, but no code ships now.

## Local engine — defaults and thresholds

| Choice | Decision | Evidence |
|---|---|---|
| STT | `faster-whisper large-v3-turbo`, CUDA, `compute_type=int8_float16` | GPU path works with `nvidia-cublas-cu12`/`nvidia-cudnn-cu12`; load 4.6 s; p50 final 424 ms (target 400 ms — near miss) |
| STT CPU fallback | `small.en`, int8 | documented fallback; not measured |
| TTS | `kokoro-onnx 0.6.1`, `kokoro-v1.0.onnx` + `voices-v1.0.bin`, 24 kHz | installs and speaks on Windows; CPU p50 476 ms (target 300 ms — **fails**) |
| VAD | Silero VAD v6 | ships inside `faster-whisper`; not separately measured |
| Turn detection | Smart Turn v3 | **not installed**; input window and rate still unconfirmed |

Decisions:

1. Keep `large-v3-turbo` on the GPU. 424 ms p50 is close enough to tune in M6 rather
   than dropping to `small.en`; peak VRAM 1070 MB is far under the 3 GB budget.
2. Kokoro on CPU does not meet the 300 ms target. In M5, try `onnxruntime-gpu` and/or
   a warm started session; if it still misses, revisit the target with S2 numbers —
   do not silently raise it.
3. Smart Turn v3 must be installed and its preprocessing confirmed in M5; the S2
   fixture labels (10 thinking pauses) stay PENDING-DEVICE until Ethan's recordings
   exist.
4. Word error rate is unmeasured (no fixtures). Keep `large-v3-turbo`; re-measure WER
   when `docs/plans/voice-spikes/fixtures/` is populated.

## Pinned facts for later milestones

- `models.lock.json` (draft): `kokoro-v1.0.onnx`
  `sha256 7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5` (325,532,387 B);
  `voices-v1.0.bin`
  `sha256 bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d` (28,214,398 B).
- Versions: `faster-whisper 1.2.1`, `ctranslate2 4.8.2`, `kokoro-onnx 0.6.1`,
  `onnxruntime 1.30.0`, `numpy 2.5.3`, Python 3.12.13.
- On Windows, a venv using ctranslate2 must install the `nvidia-*-cu12` wheels and
  register their `bin` dirs with `os.add_dll_directory`, or even CPU use fails.
