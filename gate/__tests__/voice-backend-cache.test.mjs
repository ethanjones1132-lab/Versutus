import { test } from 'node:test';
import assert from 'node:assert/strict';

import { clearVoiceBackendCache, resolveVoiceBackend } from '../core/voice/voice-backend.mjs';

// The Gate a typical voice call runs on: Claude Code first, Hermes second. Every
// candidate costs a record read, a credential resolve through the vault and — for
// an HTTP transport — a health fetch, so the walk is counted rather than guessed.
function countingManager({
  backends = {
    'claude-local': { id: 'claude-local', sendMessage: async () => ({}) },
    'hermes-local': {
      id: 'hermes-local',
      sendMessage: async () => ({}),
      sendMessageStreaming: async () => null,
      forBot: async (botId) => ({ id: `hermes-local:${botId}` }),
    },
  },
} = {}) {
  const calls = { list: 0, get: [] };
  return {
    calls,
    list: async () => {
      calls.list += 1;
      return Object.keys(backends).map((id) => ({ id }));
    },
    get: async (id) => {
      calls.get.push(id);
      if (!backends[id]) throw new Error(`unknown backend ${id}`);
      return backends[id];
    },
  };
}

const LEASE_MS = 20_000;

test('the next turn of a call resolves without walking the manager again', async () => {
  let clock = 1_000;
  const manager = countingManager();
  const options = { now: () => clock, ttlMs: LEASE_MS };
  const thread = { sessionId: 's1', botId: 'scout' };

  const first = await resolveVoiceBackend(manager, thread, options);
  assert.equal(first.id, 'hermes-local:scout');
  // The Bot branch asks every listed environment whether it can own the Bot.
  assert.deepEqual(manager.calls, { list: 1, get: ['claude-local', 'hermes-local'] });

  const second = await resolveVoiceBackend(manager, thread, options);
  assert.equal(second, first, 'the same backend answers the next turn');
  assert.deepEqual(manager.calls, { list: 1, get: ['claude-local', 'hermes-local'] });
});

test('a hit refreshes the lease, so a call that keeps talking keeps its backend', async () => {
  let clock = 1_000;
  const manager = countingManager();
  const options = { now: () => clock, ttlMs: LEASE_MS };
  const thread = { sessionId: 's1' };

  await resolveVoiceBackend(manager, thread, options);
  // Turn after turn, each inside the lease of the last.
  for (let turn = 1; turn <= 10; turn += 1) {
    clock += LEASE_MS - 1;
    await resolveVoiceBackend(manager, thread, options);
    assert.equal(manager.calls.list, 1, `turn ${turn} reused the lease`);
  }
});

test('after the lease the manager is walked again', async () => {
  let clock = 1_000;
  const manager = countingManager();
  const options = { now: () => clock, ttlMs: LEASE_MS };
  const thread = { sessionId: 's1', botId: 'scout' };

  await resolveVoiceBackend(manager, thread, options);
  clock += LEASE_MS;
  await resolveVoiceBackend(manager, thread, options);
  assert.equal(manager.calls.list, 2, 'a backend edited mid-call is picked up');
  assert.deepEqual(manager.calls.get, [
    'claude-local', 'hermes-local',
    'claude-local', 'hermes-local',
  ]);
});

test('each thread and each Bot resolves on its own', async () => {
  const manager = countingManager();
  const options = { now: () => 1_000, ttlMs: LEASE_MS };

  const scout = await resolveVoiceBackend(manager, { sessionId: 's1', botId: 'scout' }, options);
  assert.equal(scout.id, 'hermes-local:scout');
  const anvil = await resolveVoiceBackend(manager, { sessionId: 's2', botId: 'anvil' }, options);
  assert.equal(anvil.id, 'hermes-local:anvil');
  const unscoped = await resolveVoiceBackend(manager, { sessionId: 's3' }, options);
  assert.equal(unscoped.id, 'hermes-local');
  const pinned = await resolveVoiceBackend(manager, { sessionId: 's4', backendId: 'claude-local' }, options);
  assert.equal(pinned.id, 'claude-local');
  // The three that had to find their backend each listed once, and the pinned id
  // needed no listing at all: nothing was served from another thread's lease.
  assert.equal(manager.calls.list, 3);
  assert.deepEqual(manager.calls.get.at(-1), 'claude-local');
});

test('a resolution that found nothing is never cached', async () => {
  const manager = countingManager({ backends: {} });
  const options = { now: () => 1_000, ttlMs: LEASE_MS };

  assert.equal(await resolveVoiceBackend(manager, { sessionId: 's1' }, options), null);
  // One resolution on an empty Gate lists twice: once for the streaming backend
  // and once for the first-listed fallback. Two attempts, two of each.
  assert.equal(await resolveVoiceBackend(manager, { sessionId: 's1' }, options), null);
  assert.equal(manager.calls.list, 4, 'the second attempt asks again, so a fixed environment is seen');
});

test('a resolution that threw is never cached', async () => {
  const manager = countingManager();
  const options = { now: () => 1_000, ttlMs: LEASE_MS };
  let gets = 0;
  manager.get = async () => {
    gets += 1;
    throw new Error('the environment record is gone');
  };

  assert.equal(await resolveVoiceBackend(manager, { sessionId: 's1', botId: 'scout' }, options), null);
  assert.equal(await resolveVoiceBackend(manager, { sessionId: 's1', botId: 'scout' }, options), null);
  assert.equal(manager.calls.list, 4);
  assert.equal(gets, 6, 'each attempt asked again, so a repaired environment is seen');
});

test('clearing the cache forces the next resolution', async () => {
  const manager = countingManager();
  const options = { now: () => 1_000, ttlMs: LEASE_MS };
  const thread = { sessionId: 's1', botId: 'scout' };

  await resolveVoiceBackend(manager, thread, options);
  clearVoiceBackendCache(manager);
  await resolveVoiceBackend(manager, thread, options);
  assert.equal(manager.calls.list, 2);
});

test('one Gate\'s lease is not another manager\'s', async () => {
  const options = { now: () => 1_000, ttlMs: LEASE_MS };
  const first = countingManager();
  const second = countingManager();

  await resolveVoiceBackend(first, { sessionId: 's1' }, options);
  await resolveVoiceBackend(second, { sessionId: 's1' }, options);
  assert.equal(first.calls.list, 1);
  assert.equal(second.calls.list, 1, 'the second manager resolved for itself');
});