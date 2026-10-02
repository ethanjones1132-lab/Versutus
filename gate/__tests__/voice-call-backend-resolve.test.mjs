// One resolve per call. The cost of choosing which backend answers a spoken
// turn is not small (a credential read, a health fetch, a Hermes session against
// a cold state.db), and it cannot change between two turns of one call — so it
// is paid once, when the phone asks for the session, not once per turn.
import test from 'node:test';
import assert from 'node:assert/strict';

import { runVoiceTurn } from '../core/server.mjs';
import { startVoiceBackendLease } from '../core/voice/voice-backend.mjs';
import { createVoiceRpc } from '../core/voice/voice-rpc.mjs';

// Pinned to one backend so a resolve is exactly one `get`: an unpinned Bot walks
// the environments twice (once to find the Bot's, once for the first-listed
// fallback), and these tests count resolves, not candidates.
const thread = {
  kind: 'bot',
  sessionId: 'sess-1',
  botId: 'scout',
  backendId: 'hermes-live',
};
const ctx = { deviceId: 'dev-1' };

function capabilities() {
  return () => ({
    enabled: true,
    engines: { local: { state: 'ready' }, codex: { state: 'disabled' } },
  });
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition');
    await new Promise((done) => setTimeout(done, 5));
  }
}

/** A backend manager that counts the resolutions a call actually pays for. */
function countingManager(backend, { failFirst = false } = {}) {
  const manager = {
    gets: 0,
    list: async () => [{ id: backend.id }],
    get: async () => {
      manager.gets += 1;
      if (failFirst && manager.gets === 1) throw new Error('the credential vault is locked');
      return backend;
    },
  };
  return manager;
}

function speakingBackend(extra = {}) {
  const sent = [];
  return {
    sent,
    backend: {
      id: 'hermes-live',
      async sendMessage(_sessionId, { text }) {
        sent.push(text);
        return { text: 'answered' };
      },
      ...extra,
    },
  };
}

test('voice.session.start resolves the backend before any turn, and every turn of the call reuses it', async () => {
  const { backend, sent } = speakingBackend();
  const manager = countingManager(backend);
  // The lease is the call's, not the moment's: the clock moving past the short
  // per-thread lease between two turns must not resolve anything again.
  let clock = 1_000;
  const { methods, registry } = createVoiceRpc({
    capabilities: capabilities(),
    makeId: () => 'vs-1',
    prepareCallBackend: (call) => startVoiceBackendLease(manager, call.thread, { now: () => clock }),
  });

  const grant = await methods['voice.session.start']({ engine: 'local', thread }, ctx);
  await waitFor(() => manager.gets === 1);
  assert.ok(registry.get(grant.voiceSessionId).backendLease, 'the call holds its backend');

  // Three turns, half an hour apart: the old 20 s lease would have lapsed
  // between every pair of them.
  for (const text of ['one', 'two', 'three']) {
    clock += 30 * 60_000;
    const outcome = await runVoiceTurn(manager, registry.get(grant.voiceSessionId), text, {});
    assert.equal(outcome.hasContent, true);
  }
  assert.deepEqual(sent, ['one', 'two', 'three']);
  assert.equal(manager.gets, 1, 'one call, one resolve');
});

test('the first turn awaits the resolve already in flight rather than starting another', async () => {
  const { backend } = speakingBackend();
  let release;
  let gets = 0;
  const manager = {
    list: async () => [{ id: backend.id }],
    get: () => {
      gets += 1;
      return new Promise((resolve) => { release = () => resolve(backend); });
    },
  };
  const lease = startVoiceBackendLease(manager, thread);
  const warming = lease.backend();
  await waitFor(() => gets === 1);

  const turn = runVoiceTurn(manager, { thread, backendLease: lease }, 'hi', {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gets, 1, 'nothing is resolved while the call\'s own resolve is still running');

  release();
  const outcome = await turn;
  assert.equal(outcome.hasContent, true);
  assert.equal(await warming, backend);
  assert.equal(gets, 1);
});

test('a resolve that failed at session start is retried at the first turn', async () => {
  const { backend, sent } = speakingBackend();
  const manager = countingManager(backend, { failFirst: true });
  const { methods, registry } = createVoiceRpc({
    capabilities: capabilities(),
    makeId: () => 'vs-2',
    prepareCallBackend: (call) => startVoiceBackendLease(manager, call.thread),
  });

  // The start reply never waits for the resolve, so a failure there is silent
  // until the call needs it.
  const grant = await methods['voice.session.start']({ engine: 'local', thread }, ctx);
  await waitFor(() => manager.gets === 1);
  const session = registry.get(grant.voiceSessionId);

  const outcome = await runVoiceTurn(manager, session, 'hello', {});
  assert.equal(outcome.hasContent, true, 'the first turn pays for the resolve the call could not');
  assert.deepEqual(sent, ['hello']);
  assert.equal(manager.gets, 2);

  // And it is not paid for a third time.
  await runVoiceTurn(manager, session, 'again', {});
  assert.equal(manager.gets, 2);
});

test('a call whose backend creates its own session has it warmed beside the resolve', async () => {
  // Hermes answers a voice turn by posting to the session the thread already
  // names, and creating that session against a cold state.db is the 12.6 s the
  // first reply waited for. A backend that can prepare its session says so, and
  // the call does it while it has no turn to send yet.
  const prepared = [];
  const { backend } = speakingBackend({
    async ensureSession(sessionId) {
      prepared.push(sessionId);
    },
  });
  const manager = countingManager(backend);
  const { methods, registry } = createVoiceRpc({
    capabilities: capabilities(),
    makeId: () => 'vs-3',
    prepareCallBackend: (call) => startVoiceBackendLease(manager, call.thread),
  });

  const grant = await methods['voice.session.start']({ engine: 'local', thread }, ctx);
  await waitFor(() => prepared.length === 1);
  assert.deepEqual(prepared, ['sess-1']);
  await runVoiceTurn(manager, registry.get(grant.voiceSessionId), 'hi', {});
});