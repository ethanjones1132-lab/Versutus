// ─── A call can start in a chat with nothing in it yet (VS-124) ──────────
// The phone used to be told to send a message first when a thread had no
// session: a brand-new chat, and a Bot Chat opened for the first time, could
// not be called at all. The Gate now opens the chat the call answers in, the
// way a first typed turn does, and names it in the grant — so the call's words
// belong to a real conversation the phone can adopt and keep sending to.
//
// These drive the real `voice.session.start` and read what it opened out of the
// registry the call's turns read, so "the reply named a session" is not the
// evidence: the session record, the thread it carries and the grant are.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createVoiceRpc } from '../core/voice/voice-rpc.mjs';
import { newVoiceCallTitle } from '../core/voice/voice-backend.mjs';

function capabilities({ local = 'ready' } = {}) {
  return () => ({
    enabled: true,
    engines: {
      local: { state: local, reason: undefined },
      codex: { state: 'disabled', reason: 'Codex realtime needs an API key' },
    },
    limits: { codexMinutesPerDay: 60, maxConcurrentCalls: 1 },
    usedToday: { localMinutes: 0, codexMinutes: 0 },
  });
}

const ctx = { deviceId: 'dev-1' };
/** A brand-new chat: the phone knows which surface it is, and no session. */
const newChatThread = { kind: 'configurable' };

test('a thread with no session makes the Gate open the chat, and the grant names it', async () => {
  const opened = [];
  const lines = [];
  const { methods, registry } = createVoiceRpc({
    capabilities: capabilities(),
    makeId: () => 'vs-call-1',
    log: (line) => lines.push(line),
    createCallSession: async (call) => {
      opened.push(call);
      return { sessionId: 'ses-opened', backendId: 'hermes-local' };
    },
  });

  const grant = await methods['voice.session.start']({ engine: 'local', thread: newChatThread }, ctx);

  // The chat was opened once, for this call, from the thread the phone sent.
  assert.equal(opened.length, 1);
  assert.equal(opened[0].voiceSessionId, 'vs-call-1');
  assert.deepEqual(opened[0].thread, newChatThread);

  // The grant names the conversation the call's words belong to.
  assert.equal(grant.chatSessionId, 'ses-opened');

  // Not only the reply: the session the call runs on carries the chat, and the
  // environment that opened it, so its turns go there and nowhere else.
  const record = registry.get(grant.voiceSessionId);
  assert.ok(record, 'the start answered without opening a session');
  assert.equal(record.thread.sessionId, 'ses-opened');
  assert.equal(record.thread.kind, 'configurable');
  assert.equal(record.thread.backendId, 'hermes-local');
  assert.ok(lines.some((line) => /voice\.session\.start chat/.test(line) && /chat=ses-opened/.test(line)));
});

test('a Bot thread with no session is scoped to the Bot, never to a bare chat', async () => {
  const opened = [];
  const { methods, registry } = createVoiceRpc({
    capabilities: capabilities(),
    makeId: () => 'vs-call-bot',
    createCallSession: async (call) => {
      opened.push(call.thread);
      return { sessionId: 'ses-bot', backendId: 'hermes-local' };
    },
  });

  const thread = { kind: 'bot', botId: 'researcher', model: 'anthropic/claude' };
  const grant = await methods['voice.session.start']({ engine: 'local', thread }, ctx);

  assert.deepEqual(opened, [thread]);
  assert.equal(grant.chatSessionId, 'ses-bot');
  const record = registry.get(grant.voiceSessionId);
  assert.equal(record.thread.kind, 'bot');
  assert.equal(record.thread.botId, 'researcher');
  assert.equal(record.thread.sessionId, 'ses-bot');
  // The model the phone named still travels with the thread, so the session the
  // Gate opened can be born pinned to it.
  assert.equal(record.thread.model, 'anthropic/claude');
});

test('the backend resolve is given the chat the call really answers in', async () => {
  const leased = [];
  const { methods } = createVoiceRpc({
    capabilities: capabilities(),
    makeId: () => 'vs-call-lease',
    createCallSession: async () => ({ sessionId: 'ses-opened' }),
    prepareCallBackend: (call) => {
      leased.push(call.thread);
      return null;
    },
  });

  await methods['voice.session.start']({ engine: 'local', thread: newChatThread }, ctx);

  // A lease resolved from the pre-session thread would resolve the default
  // environment again on every turn and could never find the chat it opened.
  assert.equal(leased.length, 1);
  assert.equal(leased[0].sessionId, 'ses-opened');
});

test('a thread that already names a session opens nothing new', async () => {
  let calls = 0;
  const { methods } = createVoiceRpc({
    capabilities: capabilities(),
    makeId: () => 'vs-existing',
    createCallSession: async () => {
      calls += 1;
      return { sessionId: 'ses-wrong' };
    },
  });

  const grant = await methods['voice.session.start'](
    { engine: 'local', thread: { kind: 'bot', sessionId: 'ses-typed', botId: 'b1' } },
    ctx,
  );

  assert.equal(calls, 0, 'a call on an existing chat must not open another');
  assert.equal(grant.chatSessionId, 'ses-typed');
});

test('a chat the Gate cannot open refuses the start and holds nothing', async () => {
  const { methods, registry } = createVoiceRpc({
    capabilities: capabilities(),
    makeId: () => 'vs-failed',
    createCallSession: async () => {
      throw Object.assign(new Error('Hermes is not attached'), { code: 'unknown_backend', status: 404 });
    },
  });

  await assert.rejects(
    () => methods['voice.session.start']({ engine: 'local', thread: newChatThread }, ctx),
    (error) => error.code === 'unknown_backend' && error.status === 404,
  );

  // Nothing was granted, so the device is not held by a call that never opened
  // and the operator's retry is not `call_in_progress`.
  assert.equal(registry.sessions.size, 0);
  assert.equal(registry.liveForDevice('dev-1'), null);
});

test('a creation that answers no id is a named refusal, not a silent grant', async () => {
  const { methods, registry } = createVoiceRpc({
    capabilities: capabilities(),
    makeId: () => 'vs-empty',
    createCallSession: async () => ({}),
  });

  await assert.rejects(
    () => methods['voice.session.start']({ engine: 'local', thread: newChatThread }, ctx),
    (error) => error.code === 'session_start_failed',
  );
  assert.equal(registry.sessions.size, 0);
});

test('a Gate with no way to open a chat names that instead of a missing session', async () => {
  const { methods } = createVoiceRpc({ capabilities: capabilities() });

  await assert.rejects(
    () => methods['voice.session.start']({ engine: 'local', thread: newChatThread }, ctx),
    (error) => error.code === 'session_unavailable' && error.status === 501,
  );
});

test('a malformed thread is still refused, with or without a session', async () => {
  const { methods } = createVoiceRpc({ capabilities: capabilities() });

  // Not a Bot and not the chat: there is no conversation this call could open.
  await assert.rejects(
    () => methods['voice.session.start']({ engine: 'local', thread: { kind: 'group', groupId: 'g1' } }, ctx),
    (error) => error.code === 'invalid_request',
  );
  // A session id that is not a non-empty string is not a chat either.
  await assert.rejects(
    () => methods['voice.session.start']({ engine: 'local', thread: { kind: 'configurable', sessionId: 42 } }, ctx),
    (error) => error.code === 'invalid_request',
  );
  // An empty string means "no session yet", exactly like an absent field.
  const { methods: withCreator } = createVoiceRpc({
    capabilities: capabilities(),
    makeId: () => 'vs-empty-string',
    createCallSession: async () => ({ sessionId: 'ses-opened' }),
  });
  const grant = await withCreator['voice.session.start'](
    { engine: 'local', thread: { kind: 'configurable', sessionId: '' } },
    ctx,
  );
  assert.equal(grant.chatSessionId, 'ses-opened');
});

// The phone adopts the chat from the live call's own record when the start
// reply's id did not reach it — the session has to be answerable by the device
// that owns the call, and by nobody else.
test('voice.session.chat answers with the live call’s conversation', async () => {
  const { methods, registry } = createVoiceRpc({
    capabilities: capabilities(),
    makeId: () => 'vs-chat',
    createCallSession: async () => ({ sessionId: 'ses-opened' }),
  });

  assert.deepEqual(
    await methods['voice.session.chat']({}, ctx),
    { voiceSessionId: null, sessionId: null },
    'no live call is no conversation, not an error',
  );

  const grant = await methods['voice.session.start']({ engine: 'local', thread: newChatThread }, ctx);
  assert.deepEqual(await methods['voice.session.chat']({}, ctx), {
    voiceSessionId: grant.voiceSessionId,
    sessionId: 'ses-opened',
  });

  // Another phone has no live call, so it is told nothing about this one.
  assert.deepEqual(
    await methods['voice.session.chat']({}, { deviceId: 'dev-2' }),
    { voiceSessionId: null, sessionId: null },
  );

  registry.end(grant.voiceSessionId);
  assert.deepEqual(
    await methods['voice.session.chat']({}, ctx),
    { voiceSessionId: null, sessionId: null },
    'an ended call has no conversation to adopt',
  );
});

test('a call’s chat is titled as a call, and two calls never share a title', () => {
  const first = newVoiceCallTitle(new Date('2026-11-17T14:32:05Z'));
  assert.match(first, /^Call · 17 Nov 2026 · 14:32/);
  const second = newVoiceCallTitle(new Date('2026-11-17T14:32:41Z'));
  assert.notEqual(second, first, 'Hermes answers a duplicate title with the existing session');
  const third = newVoiceCallTitle(new Date('2026-11-17T14:32:59Z'));
  assert.notEqual(third, first);
  assert.notEqual(third, second);
  // Another minute starts clean again.
  assert.doesNotMatch(newVoiceCallTitle(new Date('2026-11-17T14:33:01Z')), /\(\d+\)$/);
});
