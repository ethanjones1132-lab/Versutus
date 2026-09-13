import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'voice-spikes', 's2-local-pipeline.py'), 'utf8');

test('S2 loads the two Whisper models the plan names', () => {
  assert.match(source, /large-v3-turbo/);
  assert.match(source, /small\.en/);
  assert.match(source, /WhisperModel/);
});

test('S2 loads Kokoro, Silero VAD and Smart Turn', () => {
  assert.match(source, /kokoro/i);
  assert.match(source, /silero/i);
  assert.match(source, /smart.?turn/i);
});

test('S2 runs 20 utterances, 10 of them with a thinking pause', () => {
  assert.match(source, /20/);
  assert.match(source, /pause/i);
});

test('S2 records latency, word error rate, first audio, VRAM and pinned versions', () => {
  assert.match(source, /wer/i);
  assert.match(source, /first.?audio|first_audio/i);
  assert.match(source, /vram/i);
  assert.match(source, /nvidia-smi/);
  assert.match(source, /models\.lock\.json/);
  assert.match(source, /s2-/);
});
