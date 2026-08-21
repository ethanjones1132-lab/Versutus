import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateBotId,
  createBotArgs,
  ensureDistinctListenKey,
} from '../core/cli-environments/hermes-bot-create.mjs';

test('validateBotId accepts directory ids and rejects default', () => {
  assert.equal(validateBotId('researcher'), 'researcher');
  assert.equal(validateBotId('Default'), null);
  assert.equal(validateBotId('default'), null);
  assert.equal(validateBotId('has space'), null);
  assert.equal(validateBotId('../etc'), null);
});

test('createBotArgs is a fixed argv — inherit is clone-from default only', () => {
  assert.deepEqual(createBotArgs({ name: 'coder', inheritKeys: false }), [
    'profile', 'create', 'coder', '--no-alias',
  ]);
  assert.deepEqual(createBotArgs({ name: 'coder', inheritKeys: true, description: 'Writes patches' }), [
    'profile', 'create', 'coder', '--no-alias', '--clone-from', 'default', '--description', 'Writes patches',
  ]);
});

test('ensureDistinctListenKey adds a key on empty env without copying provider secrets', () => {
  const { envText, listenKey } = ensureDistinctListenKey('# comment\n', 'default-listen');
  assert.equal(listenKey.length, 64);
  assert.match(envText, /^API_SERVER_KEY=/m);
  assert.equal(envText.includes('OPENAI'), false);
});

test('ensureDistinctListenKey rotates a cloned default key', () => {
  const cloned = 'OPENAI_API_KEY=sk-keep\nAPI_SERVER_KEY=default-listen\n';
  const { envText, listenKey } = ensureDistinctListenKey(cloned, 'default-listen');
  assert.notEqual(listenKey, 'default-listen');
  assert.match(envText, /OPENAI_API_KEY=sk-keep/);
  assert.match(envText, new RegExp(`API_SERVER_KEY=${listenKey}`));
});

test('ensureDistinctListenKey keeps a unique existing key', () => {
  const { listenKey } = ensureDistinctListenKey('API_SERVER_KEY=already-unique\n', 'default-listen');
  assert.equal(listenKey, 'already-unique');
});
