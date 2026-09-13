# Voice — `voice install` fetches the Whisper weights (2026-09-13)

The last named non-device gap of M5/M6 (`docs/plans/2026-09-12-voice-m5.md`,
"Not done by this milestone (later)"): `voice install` downloads Kokoro and
Smart Turn but not the speech-to-text weights — faster-whisper downloads
`large-v3-turbo` on first load instead. §4.6's install step says the models
(≈2 GB) are downloaded and SHA-256-verified.

## Decision

- Add the five `mobiuslabsgmbh/faster-whisper-large-v3-turbo` files to
  `gate/voice-worker/models.lock.json` under `whisper/<file>`, each with its HF
  `resolve` URL, content SHA-256 and byte size. The hashes were measured from
  this PC's HuggingFace cache (the file content, not the cache filename).
- Mark them `"optional": true`: the worker is runnable without them (the
  fallback is faster-whisper's own first-load download), so `voiceStatus` and
  `voice doctor` must not report the runtime unready until a 1.6 GB download
  finishes. `voice install` still fetches every locked model, optional ones
  included.
- Teach `load_whisper` to load the flat pre-installed directory
  (`<models>/whisper/`) when all five files are present, before falling back to
  the current first-load/HF-cache path. The check is a pure helper so it is
  unit-testable without importing a model library.

## Files in play

- Modify `gate/voice-worker/models.lock.json` (five Whisper entries)
- Modify `gate/core/voice/runtime.mjs` (`localStatus` / `voiceDoctor` skip
  optional models for readiness; `installVoice` gains an injectable `lock` so
  the fetch test never downloads the real weights)
- Modify `gate/voice-worker/versutus_voice/server.py` (`whisper_model_dir`,
  `load_whisper`)
- Modify `gate/__tests__/voice-runtime.test.mjs`,
  `gate/voice-worker/tests/test_server.py` (or `test_pipeline.py`)

## Task 1 — the lock entries and the optional readiness rule

1. Failing `node:test`: with an injected lock whose only missing model is
   `optional`, `voiceStatus` still reports `ready`; `installVoice` fetches the
   optional model and writes `whisper/model.bin`; a present-but-wrong optional
   file is still re-fetched.
2. Run: `cd gate; node --test "__tests__/voice-runtime.test.mjs"`.
3. Implement the lock entries, the `optional` filter in `localStatus` /
   `voiceDoctor`, and the `lock` injection.
4. Run green.

## Task 2 — the worker prefers the pre-installed weights

1. Failing pytest: `whisper_model_dir` returns the directory only when all five
   files exist, else `None`.
2. Implement `whisper_model_dir` + the `load_whisper` local-dir branch.
3. `node gate/voice-worker/run-tests.mjs` green.

## Task 3 — gate and commit

`npm run verify` EXIT=0, then

```
git add gate/voice-worker/models.lock.json gate/voice-worker/versutus_voice/server.py gate/voice-worker/tests gate/core/voice/runtime.mjs gate/__tests__/voice-runtime.test.mjs
git commit -m "feat(voice): voice install fetches the speech-to-text weights"
```

## Acceptance

- **PENDING-HOST:** the real ≈1.6 GB Whisper download was not run on this host
  (the weights are already in the HF cache and a download is a host operation);
  a fresh `voice install` fetches and hash-verifies them by construction.
