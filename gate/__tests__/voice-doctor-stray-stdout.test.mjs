import { test } from 'node:test';
import assert from 'node:assert/strict';
import { voiceDoctor } from '../core/voice/runtime.mjs';

test('voice doctor reports stray probe stdout as a named failure', () => {
  const result = voiceDoctor({
    paths: { python: process.execPath, worker: process.cwd(), models: process.cwd() },
    spawnSync: () => ({ status: 0, stdout: 'warning: unexpected output\nnot-json', stderr: '' }),
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.checks.at(-1), { name: 'probe', ok: false, detail: 'warning: unexpected output' });
});
