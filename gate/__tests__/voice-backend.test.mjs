import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveVoiceBackend } from '../core/voice/voice-backend.mjs';

// The order a typical Gate lists its environments in: Claude Code first.
function manager() {
  const backends = {
    'claude-local': { id: 'claude-local', sendMessage: async () => ({}) },
    'hermes-local': {
      id: 'hermes-local',
      sendMessage: async () => ({}),
      sendMessageStreaming: async () => null,
      forBot: async (botId) => ({ id: `hermes-local:${botId}` }),
    },
  };
  return {
    list: async () => Object.keys(backends).map((id) => ({ id })),
    get: async (id) => {
      if (!backends[id]) throw new Error(`unknown backend ${id}`);
      return backends[id];
    },
  };
}

test('an unscoped thread speaks to the streaming chat backend, not the first listed one', async () => {
  // 2026-09-19: every spoken turn on a Hermes thread went to Claude Code.
  const backend = await resolveVoiceBackend(manager(), { kind: 'configurable', sessionId: 's1' });
  assert.equal(backend.id, 'hermes-local');
});

test('an explicit backendId still wins', async () => {
  const backend = await resolveVoiceBackend(manager(), { sessionId: 's1', backendId: 'claude-local' });
  assert.equal(backend.id, 'claude-local');
});

test('a Bot thread resolves through the environment that owns Bots', async () => {
  const backend = await resolveVoiceBackend(manager(), { sessionId: 's1', botId: 'anvil' });
  assert.equal(backend.id, 'hermes-local:anvil');
});

test('a Gate with no streaming chat backend falls back to the first listed one', async () => {
  const only = {
    list: async () => [{ id: 'claude-local' }],
    get: async () => ({ id: 'claude-local', sendMessage: async () => ({}) }),
  };
  const backend = await resolveVoiceBackend(only, { sessionId: 's1' });
  assert.equal(backend.id, 'claude-local');
});

test('a Gate with no backends answers null', async () => {
  const none = { list: async () => [], get: async () => null };
  assert.equal(await resolveVoiceBackend(none, { sessionId: 's1' }), null);
});
