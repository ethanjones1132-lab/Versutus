import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCodexBackend } from '../core/cli-environments/backends/codex.mjs';

test('Codex listMessages honors zero, positive, and absent limits', async () => {
  const backend = createCodexBackend({ rpc: { request: async () => ({ thread: { turns: [{ items: [
    { type: 'userMessage', content: [{ type: 'text', text: 'one' }] },
    { type: 'assistantMessage', content: [{ type: 'text', text: 'two' }] },
  ] }] } }) } });
  assert.deepEqual(await backend.listMessages('thread', 0), []);
  assert.equal((await backend.listMessages('thread', 1)).length, 1);
  assert.equal((await backend.listMessages('thread')).length, 2);
});
