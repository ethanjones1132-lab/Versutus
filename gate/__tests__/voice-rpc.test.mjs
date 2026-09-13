import { test } from 'node:test';
import assert from 'node:assert/strict';

import { VoiceSessionRegistry, createVoiceRpc } from '../core/voice/voice-rpc.mjs';

function capabilities({ local = 'ready', codex = 'disabled' } = {}) {
  return () => ({
    enabled: true,
    engines: {
      local: { state: local, reason: local === 'ready' ? undefined : 'PC voice is not installed' },
      codex: { state: codex, reason: 'Codex realtime needs an API key' },
    },
    limits: { codexMinutesPerDay: 60, maxConcurrentCalls: 1 },
    usedToday: { localMinutes: 0, codexMinutes: 0 },
  });
}

const ctx = { deviceId: 'dev-1' };
const thread = { kind: 'bot', sessionId: 's1', botId: 'b1' };

test('every voice method requires a paired device', async () => {
  const { methods } = createVoiceRpc({ capabilities: capabilities() });
  await assert.rejects(() => methods['voice.capabilities']({}, { deviceId: null }), /paired device/);
  await assert.rejects(
    () => methods['voice.session.start']({ thread }, { deviceId: null }),
    /paired device/,
  );
  await assert.rejects(
    () => methods['voice.session.stop']({ voiceSessionId: 'x' }, { deviceId: null }),
    /paired device/,
  );
  await assert.rejects(() => methods['voice.install.start']({}, { deviceId: null }), /paired device/);
  await assert.rejects(() => methods['voice.install.status']({}, { deviceId: null }), /paired device/);
});

test('the phone can start an install once, and capabilities report it', async () => {
  let release;
  const install = {
    start: () => new Promise((resolve) => { release = resolve; }),
    status: () => ({ state: 'ready' }),
  };
  const { methods } = createVoiceRpc({
    capabilities: capabilities({ local: 'not-installed' }),
    install,
  });

  assert.deepEqual(await methods['voice.install.start']({}, ctx), { state: 'installing' });
  await assert.rejects(
    () => methods['voice.install.start']({}, ctx),
    (error) => error.code === 'install_in_progress' && error.status === 409,
  );
  assert.equal((await methods['voice.capabilities']({}, ctx)).engines.local.state, 'installing');
  assert.equal((await methods['voice.install.status']({}, ctx)).state, 'installing');

  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal((await methods['voice.install.status']({}, ctx)).state, 'ready');
  assert.equal((await methods['voice.capabilities']({}, ctx)).engines.local.state, 'not-installed');
});

test('a failed install is reported instead of a silent ready', async () => {
  const install = {
    start: async () => {
      throw new Error('disk full');
    },
    status: () => ({ state: 'ready' }),
  };
  const { methods } = createVoiceRpc({
    capabilities: capabilities({ local: 'not-installed' }),
    install,
  });
  await methods['voice.install.start']({}, ctx);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const status = await methods['voice.install.status']({}, ctx);
  assert.equal(status.state, 'unavailable');
  assert.match(status.reason, /disk full/);
});

test('without an installer the method refuses rather than hanging', async () => {
  const { methods } = createVoiceRpc({ capabilities: capabilities(), install: null });
  await assert.rejects(
    () => methods['voice.install.start']({}, ctx),
    (error) => error.code === 'install_unavailable' && error.status === 501,
  );
});

test('auto prefers local and reports no fallback when it is ready', async () => {
  const { methods } = createVoiceRpc({ capabilities: capabilities(), makeId: () => 'vs-1' });
  const grant = await methods['voice.session.start']({ engine: 'auto', thread }, ctx);
  assert.equal(grant.engine, 'local');
  assert.equal(grant.fellBackFrom, undefined);
  assert.equal(grant.streamPath, '/v1/voice/stream');
  assert.deepEqual(grant.input, { encoding: 'pcm16le', sampleRate: 16000, channels: 1, frameMs: 20 });
  assert.deepEqual(grant.output, { encoding: 'pcm16le', sampleRate: 24000, channels: 1 });
});

test('an unavailable explicit engine is answered with fellBackFrom and a reason', async () => {
  const { methods } = createVoiceRpc({
    capabilities: capabilities({ local: 'ready', codex: 'disabled' }),
    makeId: () => 'vs-2',
  });
  const grant = await methods['voice.session.start']({ engine: 'codex', thread }, ctx);
  assert.equal(grant.engine, 'local');
  assert.equal(grant.fellBackFrom, 'codex');
  assert.match(grant.reason, /API key|installed|disabled/i);
});

test('with no ready engine the Gate refuses and names why', async () => {
  const { methods } = createVoiceRpc({
    capabilities: capabilities({ local: 'not-installed', codex: 'disabled' }),
  });
  await assert.rejects(
    () => methods['voice.session.start']({ engine: 'auto', thread }, ctx),
    (error) => error.code === 'no_engine',
  );
});

test('one live call per device', async () => {
  let n = 0;
  const { methods } = createVoiceRpc({
    capabilities: capabilities(),
    makeId: () => `vs-${(n += 1)}`,
  });
  await methods['voice.session.start']({ engine: 'auto', thread }, ctx);
  await assert.rejects(
    () => methods['voice.session.start']({ engine: 'auto', thread }, ctx),
    (error) => error.code === 'call_in_progress' && error.status === 409,
  );
});

test('stop is owner-only and ends the session', async () => {
  const { methods, registry } = createVoiceRpc({
    capabilities: capabilities(),
    makeId: () => 'vs-9',
  });
  const grant = await methods['voice.session.start']({ engine: 'auto', thread }, ctx);
  await assert.rejects(
    () => methods['voice.session.stop']({ voiceSessionId: grant.voiceSessionId }, { deviceId: 'dev-2' }),
    (error) => error.code === 'not_your_session',
  );
  const stopped = await methods['voice.session.stop']({ voiceSessionId: grant.voiceSessionId }, ctx);
  assert.deepEqual(stopped, { stopped: true });
  assert.equal(registry.get(grant.voiceSessionId).ended, true);
});

test('the registry tracks one live session per device', () => {
  const registry = new VoiceSessionRegistry();
  registry.create({ voiceSessionId: 'a', deviceId: 'dev-1', engine: 'local' });
  assert.equal(registry.liveForDevice('dev-1').voiceSessionId, 'a');
  assert.equal(registry.liveForDevice('dev-2'), null);
  registry.end('a');
  assert.equal(registry.liveForDevice('dev-1'), null);
});
