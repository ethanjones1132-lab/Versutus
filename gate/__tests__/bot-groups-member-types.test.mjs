import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateGroup } from '../core/cli-environments/bot-groups.mjs';

test('group members must be non-empty id strings before dedupe', () => {
  for (const memberIds of ['ab', ['a', ' '], ['a', {}], null]) {
    assert.equal(validateGroup({ name: 'crew', memberIds }).ok, false);
  }
  assert.deepEqual(validateGroup({ name: ' crew ', memberIds: ['a', 'b', 'a'] }), {
    ok: true, memberIds: ['a', 'b'], name: 'crew',
  });
});
