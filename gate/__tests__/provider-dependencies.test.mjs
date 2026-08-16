import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assertProviderDeletionAllowed, dependentsOf } from '../core/providers/dependencies.mjs';

const agents = [
  { id: 'hermes-local', dependencies: [{ providerId: 'xai-main', role: 'primary' }] },
  { id: 'other', dependencies: [{ providerId: 'openai-main', role: 'primary' }] },
];

test('provider deletion reports dependent agent ids', () => {
  assert.deepEqual(dependentsOf('xai-main', agents), ['hermes-local']);
  assert.throws(
    () => assertProviderDeletionAllowed('xai-main', agents),
    /hermes-local|dependent/i,
  );
});

test('provider deletion proceeds after explicit resolution', () => {
  assert.doesNotThrow(() => assertProviderDeletionAllowed('xai-main', agents, { resolve: ['hermes-local'] }));
});
