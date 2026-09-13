import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { fetchVerified, installVoice, voicePaths, voiceStatus } from '../core/voice/runtime.mjs';

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'voice-runtime-'));
}

function bodyResponse(buffer, { status = 200 } = {}) {
  return async () => ({ ok: true, status, body: Readable.from([buffer]) });
}

test('voicePaths resolves the venv and models under the Gate home', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local' };
  const paths = voicePaths(env, 'win32');
  assert.equal(paths.home, 'C:\\Users\\Test\\AppData\\Local\\Versutus\\Gate');
  assert.ok(paths.venv.startsWith(paths.home));
  assert.ok(paths.models.startsWith(paths.home));
  assert.ok(paths.models.endsWith('models'));
  assert.ok(paths.python.endsWith('python.exe'));
  assert.ok(paths.worker.endsWith('voice-worker'));
});

test('a downloaded file is kept only when its hash matches', async () => {
  const dir = tempDir();
  const dest = join(dir, 'model.bin');
  const bytes = Buffer.from('the-model-bytes');

  await fetchVerified({ url: 'https://example/model.bin', sha256: sha256(bytes), dest, fetchImpl: bodyResponse(bytes) });
  assert.ok(existsSync(dest));
  assert.equal(readFileSync(dest).toString(), 'the-model-bytes');
});

test('a hash mismatch is refused and leaves no final file', async () => {
  const dir = tempDir();
  const dest = join(dir, 'model.bin');
  const bytes = Buffer.from('wrong-bytes');
  await assert.rejects(
    fetchVerified({ url: 'https://example/model.bin', sha256: sha256(Buffer.from('right-bytes')), dest, fetchImpl: bodyResponse(bytes) }),
    (error) => error.code === 'hash_mismatch',
  );
  assert.equal(existsSync(dest), false);
});

test('a partial download resumes from the byte it stopped at', async () => {
  const dir = tempDir();
  const dest = join(dir, 'model.bin');
  const full = Buffer.from('0123456789abcdef');
  writeFileSync(`${dest}.part`, full.subarray(0, 8));

  let rangeHeader;
  const fetchImpl = async (_url, options) => {
    rangeHeader = options?.headers?.Range;
    return { ok: true, status: 206, body: Readable.from([full.subarray(8)]) };
  };

  await fetchVerified({ url: 'https://example/model.bin', sha256: sha256(full), dest, fetchImpl });
  assert.equal(rangeHeader, 'bytes=8-');
  assert.equal(readFileSync(dest).toString(), '0123456789abcdef');
});

test('installVoice runs uv and downloads every locked model, and a failure rejects', async () => {
  const dir = tempDir();
  const paths = voicePaths({ VERSUTUS_GATE_HOME: dir }, 'linux');
  mkdirSync(paths.models, { recursive: true });

  const calls = [];
  const runUv = async (args) => {
    calls.push(args);
    if (args[1] === 'install') throw new Error('uv install failed');
  };
  const fetchCalls = [];
  const fetchImpl = async (url) => {
    fetchCalls.push(url);
    return { ok: true, status: 200, body: Readable.from([Buffer.from('x')]) };
  };

  await assert.rejects(
    installVoice({ paths, cpu: true, runUv, fetch: fetchImpl }),
    /uv install failed/,
  );
  assert.equal(calls[0][0], 'venv');
  assert.ok(calls[0].includes('3.12'));
  assert.equal(fetchCalls.length, 0, 'no model download may start before the venv is installed');
});

test('voiceStatus reports not-installed without a venv and ready with one', () => {
  const dir = tempDir();
  const paths = voicePaths({ VERSUTUS_GATE_HOME: dir }, 'linux');
  let status = voiceStatus({ paths });
  assert.equal(status.engines.local.state, 'not-installed');
  assert.equal(status.engines.codex.state, 'disabled');

  mkdirSync(paths.venv, { recursive: true });
  mkdirSync(join(paths.venv, 'bin'), { recursive: true });
  mkdirSync(paths.models, { recursive: true });
  writeFileSync(paths.python, '#!/bin/sh');
  for (const name of ['kokoro-v1.0.onnx', 'voices-v1.0.bin']) {
    writeFileSync(join(paths.models, name), 'model');
  }
  status = voiceStatus({ paths });
  assert.equal(status.engines.local.state, 'ready');
});
