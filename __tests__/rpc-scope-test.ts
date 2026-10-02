import { GatewayRpcError, readsABackend, rpcParamsWithScope } from '@/lib/gateway/rpc-scope';

// The RPC route posts `{ method, params }` exactly as the caller wrote it,
// while every REST helper here has always carried the thread's scope
// (`withScope` in manifest-client.ts). Without that, the Gate had to guess which
// attached environment a session call meant, guessed the first one that could
// list sessions — Claude Code on a typical Gate — and reported a healthy Hermes
// session as `Session not found`. `params.bot` was never read at all.

describe('which RPC methods need the thread\'s scope', () => {
  test('the session family and the model catalogue do', () => {
    for (const method of ['session.get', 'session.restore', 'session.messages', 'session.usage',
      'sessions.list', 'sessions.current', 'models.list']) {
      expect(readsABackend(method)).toBe(true);
    }
  });

  test('a gate-global method does not', () => {
    // device.*, voice.*, registry.*, providers.*, notifications.*, config.*,
    // logs.*, diagnostics.* and doctor.* answer for the Gate itself.
    for (const method of ['health', 'device.list', 'device.revoke', 'voice.session.start',
      'registry.instances.list', 'providers.refresh', 'notifications.test',
      'config.get', 'logs.tail', 'diagnostics.full', 'doctor.memory.status',
      'environments.list', 'environments.check']) {
      expect(readsABackend(method)).toBe(false);
    }
  });

  test('cron, jobs and Bots stay unpinned: they are the Gate\'s own surfaces', () => {
    // A thread's environment is Claude Code whenever configurable chat is on,
    // and `bots.get` against Claude Code answers 501 "This backend does not
    // implement bots" — the same pinning that broke Bot Chat on the REST routes.
    for (const method of ['cron.list', 'cron.runs', 'jobs.create', 'bots.list', 'bots.get']) {
      expect(readsABackend(method)).toBe(false);
    }
  });

  test('tools.list and skills.list stay unpinned: only Hermes implements them', () => {
    // Pinned to a Claude Code / Codex / OpenCode thread they answer
    // "This gateway's backend does not implement listToolsets", where unscoped
    // the Gate serves them from the one backend that can.
    for (const method of ['tools.list', 'skills.list']) {
      expect(readsABackend(method)).toBe(false);
      expect(rpcParamsWithScope(method, {}, { backendId: 'claude-local' })).toEqual({});
    }
  });
});

describe('folding the scope into RPC params', () => {
  test('a session read carries the environment the thread is on', () => {
    expect(rpcParamsWithScope('session.restore', { sessionId: 'api_1' }, { backendId: 'hermes-local' }))
      .toEqual({ sessionId: 'api_1', backendId: 'hermes-local' });
  });

  test('a Bot travels alone, because a Bot names its own environment', () => {
    expect(rpcParamsWithScope('session.restore', { sessionId: 'api_1' }, {
      backendId: 'claude-local',
      botId: 'default',
    })).toEqual({ sessionId: 'api_1', bot: 'default' });
  });

  test('a caller that named its own scope keeps it whole', () => {
    // Half of a caller's scope plus half of the client's is a scope neither
    // asked for, and the Gate honours the explicit pin.
    expect(rpcParamsWithScope('session.get', { sessionId: 's1', backendId: 'other' }, { backendId: 'mine' }))
      .toEqual({ sessionId: 's1', backendId: 'other' });
    expect(rpcParamsWithScope('session.get', { sessionId: 's1', bot: 'atlas' }, { botId: 'default' }))
      .toEqual({ sessionId: 's1', bot: 'atlas' });
  });

  test('a gate-global method is posted exactly as written', () => {
    const params = { deviceId: 'd1' };
    expect(rpcParamsWithScope('device.list', params, { backendId: 'hermes-local', botId: 'default' }))
      .toEqual({ deviceId: 'd1' });
    expect(rpcParamsWithScope('voice.session.start', { text: 'hi' }, { backendId: 'hermes-local' }))
      .toEqual({ text: 'hi' });
  });

  test('nothing is added when the client holds no scope', () => {
    expect(rpcParamsWithScope('sessions.list', { limit: 50 }, {})).toEqual({ limit: 50 });
    expect(rpcParamsWithScope('sessions.list', { limit: 50 }, { backendId: undefined })).toEqual({ limit: 50 });
  });

  test('the caller\'s params object is never mutated', () => {
    const params = { sessionId: 'api_1' };
    rpcParamsWithScope('session.restore', params, { backendId: 'hermes-local' });
    expect(params).toEqual({ sessionId: 'api_1' });
  });
});

describe('a refusal that carries the gate\'s code', () => {
  test('the code survives on the thrown Error', () => {
    // `unknown_session` is what a thread tap acts on; it cannot be told from
    // any other failure while the code is dropped.
    const error = new GatewayRpcError('Session not found: api_1', 'unknown_session');
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('unknown_session');
    expect(error.message).toBe('Session not found: api_1');
  });
});
