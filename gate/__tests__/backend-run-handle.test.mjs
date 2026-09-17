import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeBackendRunHandle, decodeBackendRunHandle, scopeBackendRunResponse, backendRunArchiveKey,
} from '../core/cli-environments/backend-run-handle.mjs';

test('run handles round-trip opaque ids without placing path separators on the wire', () => {
  const backendId = 'hermes-local';
  const runId = 'run/with spaces?and=unicode-λ';
  const handle = encodeBackendRunHandle(backendId, runId);
  assert.match(handle, /^[A-Za-z0-9._-]+$/);
  assert.deepEqual(decodeBackendRunHandle(handle), { backendId, runId });
  assert.equal(decodeBackendRunHandle('legacy_run'), null);
});

test('malformed scoped handles are refused rather than treated as legacy ids', () => {
  for (const payload of ['', 'garbage', '{}', '[]', '["a"]', '["a",""]', '["a",2]', '["a","b","c"]']) {
    assert.throws(() => decodeBackendRunHandle(`gate-run-v1.${Buffer.from(payload).toString('base64url')}`));
  }
  assert.throws(() => decodeBackendRunHandle(`${encodeBackendRunHandle('a', 'b')}=`));
});

test('run responses keep their fields and scope both supported identifier shapes', () => {
  const response = { run_id: 'run_1', id: 'run_1', status: 'completed', exit_code: 0 };
  const scoped = scopeBackendRunResponse(response, 'hermes-local');
  assert.deepEqual(scoped, {
    ...response,
    run_id: encodeBackendRunHandle('hermes-local', 'run_1'),
    id: encodeBackendRunHandle('hermes-local', 'run_1'),
  });
  assert.equal(response.run_id, 'run_1', 'the upstream object is not mutated');
  assert.deepEqual(scopeBackendRunResponse({ status: 'running' }, 'hermes-local'), { status: 'running' });
});

test('archives distinguish environments and long ids while keeping legacy filenames', () => {
  const longId = 'x'.repeat(200);
  const handles = [
    encodeBackendRunHandle('a', longId),
    encodeBackendRunHandle('b', longId),
    encodeBackendRunHandle('a', `${longId}different`),
  ];
  const keys = handles.map(backendRunArchiveKey);
  assert.equal(new Set(keys).size, 3);
  for (const key of keys) assert.match(key, /^scoped-[a-f0-9]{64}$/);
  assert.equal(backendRunArchiveKey('legacy_run'), 'legacy_run');
});


test('Bot run handles preserve Bot identity without changing existing environment handles', () => {
  const first = encodeBackendRunHandle('hermes', 'same-run', 'rook');
  const second = encodeBackendRunHandle('hermes', 'same-run', 'default');
  assert.deepEqual(decodeBackendRunHandle(first), { backendId: 'hermes', runId: 'same-run', botId: 'rook' });
  assert.notEqual(first, second);
  assert.notEqual(backendRunArchiveKey(first), backendRunArchiveKey(second));
  assert.deepEqual(scopeBackendRunResponse({ id: 'same-run' }, 'hermes', 'rook'), { id: first });
  assert.match(encodeBackendRunHandle('hermes', 'same-run'), /^gate-run-v1\./);
});
