import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'voice-spikes', 's1-codex-realtime.mjs'), 'utf8');

test('S1 spawns codex app-server with and without the realtime feature flag', () => {
  assert.match(source, /'app-server'/);
  assert.match(source, /features\.realtime_conversation=true/);
  assert.match(source, /withFlag|withoutFlag/);
});

test('S1 initialises with the experimental API and probes voices', () => {
  assert.match(source, /experimentalApi:\s*true/);
  assert.match(source, /thread\/realtime\/listVoices/);
});

test('S1 starts a read-only ephemeral thread and a client-managed websocket realtime session', () => {
  assert.match(source, /sandbox:\s*'read-only'/);
  assert.match(source, /approvalPolicy:\s*'never'/);
  assert.match(source, /ephemeral:\s*true/);
  assert.match(source, /outputModality:\s*'audio'/);
  assert.match(source, /type:\s*'websocket'/);
  assert.match(source, /clientManagedHandoffs:\s*true/);
});

test('S1 streams both input rates, appends speech and stops, and writes a JSONL capture', () => {
  assert.match(source, /appendAudio/);
  assert.match(source, /24000/);
  assert.match(source, /16000/);
  assert.match(source, /appendSpeech/);
  assert.match(source, /thread\/realtime\/stop/);
  assert.match(source, /s1-/);
});
