import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenCodeBackend } from '../core/cli-environments/backends/opencode.mjs';

const response = (body, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body });

for (const major of [1, 2]) {
  test(`OpenCode v${major} listMessages honors zero, positive, and absent limits`, async () => {
    const fetchImpl = async (url) => {
      if (url.endsWith('/api/info')) return response(major === 2 ? { version: '2.0.0' } : {});
      if (url.endsWith('/session')) return response(major === 2 ? {} : []);
      if (url.includes('/message')) {
        return response(major === 2
          ? { data: [{ id: 'a', role: 'user', parts: [{ type: 'text', text: 'one' }] }, { id: 'b', role: 'assistant', parts: [{ type: 'text', text: 'two' }] }] }
          : [{ info: { id: 'a', role: 'user' }, parts: [{ type: 'text', text: 'one' }] }, { info: { id: 'b', role: 'assistant' }, parts: [{ type: 'text', text: 'two' }] }]);
      }
      return response({});
    };
    const backend = createOpenCodeBackend({ baseUrl: 'http://localhost:1', fetchImpl });
    assert.deepEqual(await backend.listMessages('session', 0), []);
    assert.equal((await backend.listMessages('session', 1)).length, 1);
    assert.equal((await backend.listMessages('session')).length, 2);
  });
}
