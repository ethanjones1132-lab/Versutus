// A call is answered by the backend its thread lives in. The phone names a Bot
// when the thread is a Bot's, and (from this build on) the backend and model of
// an ordinary thread. A phone that names neither is not an unscoped thread: the
// session it carries was created in exactly one environment, and the Gate knows
// which. Answering it from the default sent an OpenCode conversation to Claude
// Code, which exited half a second after the operator stopped talking
// (2026-11-15).
import test from 'node:test';
import assert from 'node:assert/strict';

import { runVoiceTurn, voiceThreadModel } from '../core/server.mjs';
import {
  findSessionEnvironment,
  locateVoiceThread,
  startVoiceBackendLease,
} from '../core/voice/voice-backend.mjs';
import { describeTurnFailure } from '../core/voice/turn-failure.mjs';

function backendNamed(kind, sent = []) {
  return {
    kind,
    async sendMessage(sessionId, input) {
      sent.push({ kind, sessionId, text: input.text, model: input.model });
      return { text: `answered by ${kind}` };
    },
  };
}

/** Two environments, Claude Code listed first, as on the host this broke on. */
function twoEnvironments() {
  const sent = [];
  const backends = {
    'claude-code': backendNamed('claude-code', sent),
    'opencode-local': backendNamed('opencode', sent),
  };
  const manager = {
    gets: [],
    list: async () => Object.keys(backends).map((id) => ({ id })),
    get: async (id) => {
      manager.gets.push(id);
      if (!backends[id]) throw new Error(`unknown backend ${id}`);
      return backends[id];
    },
  };
  return { manager, sent };
}

// The default rule: with no scope, the configured default answers.
const selection = { stateOf: () => 'ready', defaultId: 'claude-code' };

test('a thread that names its backend is answered by it', async () => {
  const { manager, sent } = twoEnvironments();
  const session = { thread: { kind: 'configurable', sessionId: 'ses_1', backendId: 'opencode-local' } };
  const result = await runVoiceTurn(manager, session, 'hello', {}, { selection });
  assert.equal(result.hasContent, true);
  assert.deepEqual(sent.map((entry) => entry.kind), ['opencode']);
});

test('a thread that names nothing is answered by the environment that holds its session', async () => {
  const { manager, sent } = twoEnvironments();
  const seen = [];
  const locate = async (thread) => {
    seen.push(thread.sessionId);
    return { ...thread, backendId: 'opencode-local' };
  };
  const session = { thread: { kind: 'configurable', sessionId: 'ses_e223' } };

  await runVoiceTurn(manager, session, 'hello', {}, { selection, locate });
  assert.deepEqual(seen, ['ses_e223']);
  assert.deepEqual(sent.map((entry) => entry.kind), ['opencode'], 'not the default backend');
  assert.equal(sent[0].sessionId, 'ses_e223');
});

test('a session no environment claims still falls back to the default rule', async () => {
  const { manager, sent } = twoEnvironments();
  const session = { thread: { kind: 'configurable', sessionId: 'ses_new' } };
  await runVoiceTurn(manager, session, 'hello', {}, { selection, locate: async (thread) => thread });
  assert.deepEqual(sent.map((entry) => entry.kind), ['claude-code']);
});

test('a lookup that throws leaves the thread as the phone sent it', async () => {
  const thread = { kind: 'configurable', sessionId: 'ses_1' };
  const located = await locateVoiceThread(thread, async () => {
    throw new Error('the session index is unreadable');
  });
  assert.deepEqual(located, { thread, via: 'default' });
});

test('a thread the phone scoped is never looked up', async () => {
  let asked = 0;
  const locate = async (thread) => {
    asked += 1;
    return thread;
  };
  const named = { kind: 'configurable', sessionId: 'ses_1', backendId: 'opencode-local' };
  assert.deepEqual(await locateVoiceThread(named, locate), { thread: named, via: 'thread' });
  const bot = { kind: 'bot', sessionId: 'ses_1', botId: 'scout' };
  assert.deepEqual(await locateVoiceThread(bot, locate), { thread: bot, via: 'thread' });
  assert.equal(asked, 0);
});

test('a call locates its session once, when it starts, and says how its backend was found', async () => {
  const { manager, sent } = twoEnvironments();
  let lookups = 0;
  const resolved = [];
  const thread = { kind: 'configurable', sessionId: 'ses_e223' };
  const lease = startVoiceBackendLease(manager, thread, {
    selection,
    locate: async (asked) => {
      lookups += 1;
      return { ...asked, backendId: 'opencode-local' };
    },
    onResolved: (detail) => resolved.push({ kind: detail.backend.kind, backendId: detail.backendId, via: detail.via }),
  });
  const session = { thread, backendLease: lease };

  await runVoiceTurn(manager, session, 'one', {}, { selection });
  await runVoiceTurn(manager, session, 'two', {}, { selection });
  assert.equal(lookups, 1);
  assert.deepEqual(resolved, [{ kind: 'opencode', backendId: 'opencode-local', via: 'session' }]);
  assert.deepEqual(sent.map((entry) => entry.kind), ['opencode', 'opencode']);
});

test('a spoken turn runs on the model the thread names', async () => {
  const { manager, sent } = twoEnvironments();
  const session = {
    thread: {
      kind: 'configurable',
      sessionId: 'ses_1',
      backendId: 'opencode-local',
      model: 'opencode-go/deepseek-v4',
    },
  };
  await runVoiceTurn(manager, session, 'hello', {}, { selection });
  assert.deepEqual(sent[0].model, { providerId: 'opencode-go', modelId: 'deepseek-v4' });

  // No model named: the backend's own default, exactly as before.
  delete session.thread.model;
  await runVoiceTurn(manager, session, 'again', {}, { selection });
  assert.equal(sent[1].model, undefined);
});

test('a thread model is read only when it is a plausible model id', () => {
  assert.deepEqual(voiceThreadModel({ model: 'sonnet' }), { modelId: 'sonnet' });
  assert.deepEqual(voiceThreadModel({ model: ' kilo/x-ai/grok ' }), { providerId: 'kilo', modelId: 'x-ai/grok' });
  assert.equal(voiceThreadModel({ model: '' }), undefined);
  assert.equal(voiceThreadModel({ model: 42 }), undefined);
  assert.equal(voiceThreadModel({ model: 'm'.repeat(300) }), undefined);
  assert.equal(voiceThreadModel(undefined), undefined);
});

// ─── Asking the environments themselves ────────────────────────────────────
// The Gate's own session index only covers the environments it indexes. The
// session of the call that failed on 2026-11-15 was an OpenCode one, in no list
// the Gate keeps, so the environments have to be asked.

function environments(map, methods = {}) {
  const started = [];
  return {
    started,
    list: async () => Object.keys(map).map((id) => ({ id })),
    get: async (id) => {
      started.push(id);
      if (map[id] instanceof Error) throw map[id];
      return map[id];
    },
    methodsOf: async (id) => (methods[id] ? new Set(methods[id]) : null),
  };
}

test('the environment that lists a session is the one that holds it', async () => {
  const manager = environments({
    'claude-code': { listSessions: async () => [{ id: 'abc' }] },
    'opencode-local': { listSessions: async () => [{ id: 'ses_other' }, { id: 'ses_e223' }] },
  });
  assert.equal(await findSessionEnvironment(manager, 'ses_e223'), 'opencode-local');
  assert.equal(await findSessionEnvironment(manager, 'ses_nobody_has'), null);
  assert.equal(await findSessionEnvironment(manager, ''), null);
});

test('an environment that can read a session by id is asked that way', async () => {
  const asked = [];
  const manager = environments({
    'hermes-local': {
      getSession: async (id) => {
        asked.push(id);
        if (id !== 'h-1') throw Object.assign(new Error('not found'), { code: 'unknown_session', status: 404 });
        return { id };
      },
      listSessions: async () => {
        throw new Error('the list is the slow read and must not be needed');
      },
    },
  });
  assert.equal(await findSessionEnvironment(manager, 'h-1'), 'hermes-local');
  assert.equal(await findSessionEnvironment(manager, 'h-2'), null);
  assert.deepEqual(asked, ['h-1', 'h-2']);
});

test('an environment that is down, slow or has no sessions does not hold up the answer', async () => {
  const manager = environments(
    {
      broken: new Error('the credential vault is locked'),
      hanging: { listSessions: () => new Promise(() => {}) },
      'no-sessions': { sendMessage: async () => ({}) },
      'opencode-local': { listSessions: async () => [{ id: 'ses_1' }] },
    },
    { 'no-sessions': ['sendMessage'] },
  );
  const startedAt = Date.now();
  assert.equal(await findSessionEnvironment(manager, 'ses_1', { boundMs: 2_000 }), 'opencode-local');
  assert.ok(Date.now() - startedAt < 1_000, 'the first environment that has it wins');
  assert.equal(manager.started.includes('no-sessions'), false, 'one that cannot list sessions is never started');

  // Nobody has it: the answer waits for the bound, not for ever.
  assert.equal(await findSessionEnvironment(manager, 'ses_missing', { boundMs: 80 }), null);
});

// ─── The sentence a failure is told in ─────────────────────────────────────

test('a turn failure is named by its kind and by the backend that failed', () => {
  const cases = [
    [new Error('claude-code exited with code 1'), 'claude-code', 'backend_exited', 'Claude Code stopped before it answered.'],
    [Object.assign(new Error('nope'), { status: 401 }), 'hermes', 'backend_auth', 'Hermes refused the sign-in the Gate has for it.'],
    [Object.assign(new Error('gone'), { status: 404 }), 'opencode', 'backend_not_found', 'OpenCode no longer has this conversation.'],
    [Object.assign(new Error('slow down'), { status: 429 }), 'codex', 'backend_rate_limited', 'Codex is rate limited right now.'],
    [Object.assign(new Error('bad gateway'), { status: 502 }), 'hermes', 'backend_unavailable', 'Hermes is not answering right now.'],
    [new Error('connect ECONNREFUSED 127.0.0.1:4096'), 'opencode', 'backend_unreachable', 'OpenCode could not be reached.'],
    [{ code: 'turn_timeout' }, 'opencode', 'turn_timeout', 'OpenCode took too long to answer.'],
    [{ code: 'empty_turn' }, undefined, 'empty_turn', 'The backend finished without saying anything.'],
    [Object.assign(new Error('eof'), { code: 'stream_truncated' }), 'hermes', 'stream_truncated', 'The reply was cut off before it finished.'],
    [new Error('the prompt was: my password is hunter2'), 'a-new-adapter', 'backend_error', 'The backend failed before it answered.'],
  ];
  for (const [error, backend, code, message] of cases) {
    assert.deepEqual(describeTurnFailure(error, { backend }), { code, message });
  }
});

test('the Gate\'s own account of having no backend is passed on as written', () => {
  const error = Object.assign(
    new Error('No chat backend could answer this call. hermes is starting; opencode-local is unreachable.'),
    { code: 'no_voice_backend' },
  );
  assert.deepEqual(describeTurnFailure(error), { code: 'no_voice_backend', message: error.message });
});

// ─── Signed out, and out of plan: the two failures the operator can fix ───
// VS-127. A CLI says both in stderr, in its own words; the phone is told what
// to do about it in one sentence naming the backend and its one fix, per
// backend. The CLI's words are kept as `details` and are never the sentence.

test('a signed-out or spent backend is named with the one fix for that backend', () => {
  const cases = [
    // The three real-world strings this ticket exists for.
    [
      new Error('claude-code: OAuth token has been revoked'),
      'claude-code',
      'backend_signed_out',
      'Claude Code on your PC is signed out. Open a terminal on the PC, run `claude`, and sign in.',
    ],
    [
      new Error("codex: You've hit your usage limit. Resets at 14:00."),
      'codex',
      'backend_quota',
      "Codex has used up its plan's limit. It resets at 14:00; until then pick another backend.",
    ],
    [
      new Error('opencode: no provider credential is configured for this model'),
      'opencode',
      'backend_signed_out',
      'OpenCode on your PC is signed out. Open a terminal on the PC, run `opencode auth login`, and sign in.',
    ],
    // The other spellings the same two failures arrive in.
    [
      new Error('codex: Please run `codex login` before sending a turn'),
      'codex',
      'backend_signed_out',
      'Codex on your PC is signed out. Open a terminal on the PC, run `codex login`, and sign in.',
    ],
    [
      new Error('opencode: rate limit exceeded; resets in 2 hours'),
      'opencode',
      'backend_quota',
      "OpenCode has used up its plan's limit. It resets in 2 hours; until then pick another backend.",
    ],
    [
      new Error('hermes: insufficient_quota'),
      'hermes',
      'backend_quota',
      "Hermes has used up its plan's limit. Until it resets, pick another backend.",
    ],
    [
      new Error('opencode: Insufficient balance. Add credit to continue.'),
      'opencode',
      'backend_quota',
      "OpenCode has used up its plan's limit. Until it resets, pick another backend.",
    ],
    [
      new Error('hermes: authentication failed'),
      'hermes',
      'backend_signed_out',
      'Hermes is signed out. Open Hermes on the PC and sign in again.',
    ],
    // Claude Code's own result line says "Failed to authenticate." before it
    // says anything else (backends/claude-code.mjs keys on that prefix): the
    // verb, not the noun, is what a real signed-out run carries.
    [
      new Error('claude-code: Failed to authenticate.'),
      'claude-code',
      'backend_signed_out',
      'Claude Code on your PC is signed out. Open a terminal on the PC, run `claude`, and sign in.',
    ],
    // Codex names the reset as "try again at 1:37 PM", which is still the
    // moment the operator can act on.
    [
      new Error("codex: You've hit your usage limit. Try again at 3:12 PM."),
      'codex',
      'backend_quota',
      "Codex has used up its plan's limit. It resets at 3:12 PM; until then pick another backend.",
    ],
    // A typed turn knows its environment id, not the kind: the id still names
    // the backend, so the sentence is the right one.
    [
      new Error('codex: your plan has reached its usage limit'),
      'codex-local',
      'backend_quota',
      "Codex has used up its plan's limit. Until it resets, pick another backend.",
    ],
    // No backend named at all: the generic sentence still says what to do.
    [
      new Error('OAuth token has been revoked'),
      undefined,
      'backend_signed_out',
      'The backend is signed out. Sign in again on the machine that runs it.',
    ],
  ];
  for (const [error, backend, code, message] of cases) {
    const failure = describeTurnFailure(error, { backend });
    assert.equal(failure.code, code, `${error.message} is ${code}`);
    assert.equal(failure.message, message);
    assert.equal(failure.details, error.message, 'the backend\'s own words ride behind as details');
    assert.ok(!failure.message.includes(error.message), 'and are never the headline');
  }
});

test('a plain rate limit stays transient, and a Gate-held key stays the Gate\'s refusal', () => {
  // "slow down" with a 429 is not a plan's ceiling: it is the transient limit.
  assert.deepEqual(
    describeTurnFailure(Object.assign(new Error('slow down'), { status: 429 }), { backend: 'codex' }),
    { code: 'backend_rate_limited', message: 'Codex is rate limited right now.' },
  );
  // A 401 whose text names no sign-in problem is still the credential the Gate
  // holds for the backend, not a CLI the operator was signed out of.
  assert.deepEqual(
    describeTurnFailure(Object.assign(new Error('nope'), { status: 401 }), { backend: 'hermes' }),
    { code: 'backend_auth', message: 'Hermes refused the sign-in the Gate has for it.' },
  );
  // A Gate-held provider key with nothing to send is NOT a CLI sign-out: the
  // CLI has no sign-in to run for it.
  const providerKey = describeTurnFailure(new Error('provider has no credential to send'), { backend: 'hermes' });
  assert.equal(providerKey.code, 'backend_error');
  // A number in the words is only the CLI's sign-in state when the throw names
  // no status: `hermes: HTTP 401` is Hermes refusing the key the GATE holds
  // (API_SERVER_KEY), so the fix is that key, not `hermes`'s own setting.
  assert.deepEqual(
    describeTurnFailure(Object.assign(new Error('hermes: HTTP 401'), { status: 401 }), { backend: 'hermes' }),
    { code: 'backend_auth', message: 'Hermes refused the sign-in the Gate has for it.' },
  );
  // With no status at all, the same number is the CLI's own account of having
  // been signed out — which is all a dead process leaves behind.
  assert.equal(
    describeTurnFailure(new Error('claude-code: 401 Unauthorized'), { backend: 'claude-code' }).code,
    'backend_signed_out',
  );
});
