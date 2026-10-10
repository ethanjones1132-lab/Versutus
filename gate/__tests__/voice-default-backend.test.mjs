import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveVoiceBackend } from '../core/voice/voice-backend.mjs';
import { runVoiceTurn } from '../core/server.mjs';

// Issue #1 follow-up: a spoken turn on an unscoped thread took the first
// environment that could stream a turn, running or not. On the Mac that was a
// Hermes that could not start, so every call failed while OpenCode sat ready.
// With the Gate's readiness view it now picks the way a typed request with no
// backendId does: configured default if usable, else the first ready one.

const STREAMING = new Set(['sendMessage', 'sendMessageStreaming', 'forBot']);
const PLAIN = new Set(['sendMessage']);

/** A typical Mac Gate: Claude Code, Hermes (streams), OpenCode, in that order. */
function readinessManager(methods = {
  'claude-local': PLAIN,
  'hermes-local': STREAMING,
  'opencode-local': PLAIN,
}) {
  const started = [];
  return {
    started,
    list: async () => Object.keys(methods).map((id) => ({ id })),
    methodsOf: async (id) => methods[id] ?? null,
    get: async (id) => {
      started.push(id);
      if (!methods[id]) throw new Error(`unknown backend ${id}`);
      const backend = { id, sendMessage: async () => ({ text: id }) };
      if (methods[id].has('forBot')) backend.forBot = async (botId) => ({ id: `${id}:${botId}` });
      return backend;
    },
  };
}

const thread = () => ({ sessionId: `s-${Math.random()}` });

test('an unscoped thread skips a streaming backend that is not ready for the first ready one', async () => {
  const manager = readinessManager();
  const states = { 'claude-local': 'not_installed', 'hermes-local': 'degraded', 'opencode-local': 'ready' };
  const backend = await resolveVoiceBackend(manager, thread(), {
    selection: { stateOf: (id) => states[id] },
  });
  assert.equal(backend.id, 'opencode-local');
  assert.deepEqual(manager.started, ['opencode-local'], 'only the chosen environment is started');
});

test('among ready backends the streaming one still goes first', async () => {
  // Keeps the 2026-09-19 fix: a Hermes thread's turns must not go to Claude Code.
  const manager = readinessManager();
  const backend = await resolveVoiceBackend(manager, thread(), {
    selection: { stateOf: () => 'ready' },
  });
  assert.equal(backend.id, 'hermes-local');
});

test('a usable configured default wins, and steps aside when it is not usable', async () => {
  const states = { 'claude-local': 'ready', 'hermes-local': 'ready', 'opencode-local': 'busy' };
  const pinned = await resolveVoiceBackend(readinessManager(), thread(), {
    selection: { stateOf: (id) => states[id], defaultId: 'opencode-local' },
  });
  assert.equal(pinned.id, 'opencode-local', 'a busy default is still usable');

  states['opencode-local'] = 'degraded';
  const fallback = await resolveVoiceBackend(readinessManager(), thread(), {
    selection: { stateOf: (id) => states[id], defaultId: 'opencode-local' },
  });
  assert.equal(fallback.id, 'hermes-local');
});

test('unprobed environments are probed in order and stop at the first ready one', async () => {
  const probed = [];
  const backend = await resolveVoiceBackend(readinessManager(), thread(), {
    selection: {
      stateOf: () => undefined,
      probe: async (id) => { probed.push(id); return id === 'claude-local' ? 'ready' : 'degraded'; },
    },
  });
  assert.equal(backend.id, 'claude-local');
  // Hermes (streaming) is asked first, then Claude Code; OpenCode never is.
  assert.deepEqual(probed, ['hermes-local', 'claude-local']);
});

test('nothing ready is a no_voice_backend error naming every state, and is not cached', async () => {
  const manager = readinessManager();
  const states = { 'claude-local': 'not_installed', 'hermes-local': 'degraded', 'opencode-local': 'stopped' };
  const selection = { stateOf: (id) => states[id], defaultId: 'codex-local' };
  const sameThread = thread();

  await assert.rejects(
    () => resolveVoiceBackend(manager, sameThread, { selection }),
    (error) => {
      assert.equal(error.code, 'no_voice_backend');
      assert.equal(error.reason, 'no_ready_backend');
      assert.match(error.message, /^No chat backend could answer this call\./);
      assert.match(error.message, /hermes-local: degraded/);
      assert.match(error.message, /claude-local: not_installed/);
      assert.match(error.message, /opencode-local: stopped/);
      assert.match(error.message, /configured default "codex-local" is not attached/);
      return true;
    },
  );
  assert.deepEqual(manager.started, [], 'nothing is started when nothing is ready');

  // The operator starts OpenCode; the very next turn of the same call finds it.
  states['opencode-local'] = 'ready';
  const backend = await resolveVoiceBackend(manager, sameThread, { selection });
  assert.equal(backend.id, 'opencode-local');
});

test('a Gate with no backends is a no_voice_backend error with the no_backend reason', async () => {
  const none = { list: async () => [], get: async () => null };
  await assert.rejects(
    () => resolveVoiceBackend(none, thread(), { selection: { stateOf: () => 'ready' } }),
    (error) => error.code === 'no_voice_backend' && error.reason === 'no_backend'
      && /No chat backend is attached/.test(error.message),
  );
});

test('a ready backend that fails to attach is named in the error', async () => {
  const manager = readinessManager();
  manager.get = async (id) => { throw new Error(`${id} credential binding missing`); };
  await assert.rejects(
    () => resolveVoiceBackend(manager, thread(), { selection: { stateOf: () => 'ready' } }),
    (error) => error.code === 'no_voice_backend' && error.reason === 'unknown_backend'
      && /hermes-local is ready but could not be attached: hermes-local credential binding missing/.test(error.message),
  );
});

test('an explicit backendId and a Bot thread are untouched by the readiness view', async () => {
  const manager = readinessManager();
  const selection = { stateOf: () => 'degraded' };
  const pinned = await resolveVoiceBackend(manager, { sessionId: 'p1', backendId: 'claude-local' }, { selection });
  assert.equal(pinned.id, 'claude-local', 'a deliberate pin is honoured even when not ready');
  const bot = await resolveVoiceBackend(manager, { sessionId: 'b1', botId: 'anvil' }, { selection });
  assert.equal(bot.id, 'hermes-local:anvil', 'a Bot still resolves through the environment that owns it');
});

test('a voice turn with nothing ready fails at resolve, names the states, and sends nothing', async () => {
  const stages = [];
  let sends = 0;
  const manager = readinessManager();
  manager.get = async (id) => ({ id, sendMessage: async () => { sends += 1; return { text: 'x' }; } });

  await assert.rejects(
    () => runVoiceTurn(manager, { thread: { sessionId: 'v1' } }, 'hi', {
      onStage: (detail) => stages.push(detail),
    }, { selection: { stateOf: () => 'degraded' } }),
    (error) => error?.code === 'no_voice_backend' && /hermes-local: degraded/.test(error.message),
  );
  assert.ok(stages.some((stage) => stage.stage === 'resolve.failed' && stage.cause === 'no_voice_backend'));
  assert.equal(sends, 0);
});

test('a voice turn on an unscoped thread is answered by the ready backend', async () => {
  const stages = [];
  const manager = readinessManager();
  const states = { 'hermes-local': 'degraded', 'opencode-local': 'ready' };
  const outcome = await runVoiceTurn(manager, { thread: { sessionId: 'v2' } }, 'hi', {
    onStage: (detail) => stages.push(detail),
  }, { selection: { stateOf: (id) => states[id] } });
  assert.equal(outcome.hasContent, true);
  assert.ok(stages.some((stage) => stage.stage === 'resolve.ready' && stage.backend === 'opencode-local'));
});
