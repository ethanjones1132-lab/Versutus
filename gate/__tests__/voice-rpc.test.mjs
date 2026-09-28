import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ATTACHED_LIVENESS_MS, VoiceSessionRegistry, createVoiceRpc } from '../core/voice/voice-rpc.mjs';

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

test("a Bot's engine preference is what auto means for that Bot", async () => {
  const botThread = { kind: 'bot', sessionId: 's1', botId: 'b1', voiceEngine: 'codex' };

  // The Bot prefers codex, but codex is not ready: fall back to local and name it.
  const notReady = createVoiceRpc({
    capabilities: capabilities({ local: 'ready', codex: 'disabled' }),
    makeId: () => 'vs-a',
  });
  const fell = await notReady.methods['voice.session.start']({ thread: botThread }, ctx);
  assert.equal(fell.engine, 'local');
  assert.equal(fell.fellBackFrom, 'codex');

  // When the preference is ready, it is chosen.
  const ready = createVoiceRpc({
    capabilities: capabilities({ local: 'ready', codex: 'ready' }),
    makeId: () => 'vs-b',
  });
  const chosen = await ready.methods['voice.session.start']({ thread: botThread }, ctx);
  assert.equal(chosen.engine, 'codex');

  // An explicit request from the phone still wins over the Bot's preference.
  const explicit = createVoiceRpc({
    capabilities: capabilities({ local: 'ready', codex: 'ready' }),
    makeId: () => 'vs-c',
  });
  const request = await explicit.methods['voice.session.start'](
    { engine: 'local', thread: botThread },
    ctx,
  );
  assert.equal(request.engine, 'local');
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

// A phone connected with the Gate's own token has no device grant. Before
// 2026-09-17 every voice method refused it, so hands-free could never start.
// It is filed under its own `bootstrap:<id>` namespace, exactly like push.
test('a bootstrap-token phone that names its device can start a call in its own namespace', async () => {
  const { methods, registry } = createVoiceRpc({ capabilities: capabilities() });
  const bootstrap = { deviceId: null, bootstrap: true };
  await methods['voice.capabilities']({ deviceId: 'phone-abc123' }, bootstrap);
  const grant = await methods['voice.session.start']({ thread, deviceId: 'phone-abc123' }, bootstrap);
  assert.ok(grant.voiceSessionId);
  assert.equal(registry.get(grant.voiceSessionId).deviceId, 'bootstrap:phone-abc123');
});

test('a bootstrap caller without a device id, or an unpaired non-bootstrap caller, is still refused', async () => {
  const { methods } = createVoiceRpc({ capabilities: capabilities() });
  await assert.rejects(
    () => methods['voice.session.start']({ thread }, { deviceId: null, bootstrap: true }),
    /paired device/,
  );
  await assert.rejects(
    () => methods['voice.session.start']({ thread, deviceId: 'phone-abc123' }, { deviceId: null, bootstrap: false }),
    /paired device/,
  );
});

test('a session start or failure is written to the Gate log', async () => {
  const lines = [];
  const { methods } = createVoiceRpc({
    capabilities: capabilities(),
    makeId: () => 'vs-log',
    log: (line) => lines.push(line),
  });
  await methods['voice.session.start']({ engine: 'local', thread }, ctx);
  assert.ok(lines.some((line) => /voice.session.start ok/.test(line) && /engine=local/.test(line) && /session=vs-log/.test(line)));
  assert.ok(lines.every((line) => !/tok-|Bearer|token=/i.test(line)));

  const failing = [];
  const refused = createVoiceRpc({
    capabilities: capabilities({ local: 'not-installed', codex: 'disabled' }),
    log: (line) => failing.push(line),
  });
  await assert.rejects(() => refused.methods['voice.session.start']({ engine: 'auto', thread }, ctx));
  assert.ok(failing.some((line) => /voice.session.start fail/.test(line) && /no_engine/.test(line)));
});

test('capabilities log the live engine states without a token', async () => {
  const lines = [];
  const { methods } = createVoiceRpc({
    capabilities: capabilities(),
    log: (line) => lines.push(line),
  });
  await methods['voice.capabilities']({}, ctx);
  assert.ok(lines.some((line) => /voice.capabilities/.test(line) && /local=ready/.test(line)));
  assert.ok(lines.every((line) => !/Bearer|token=/i.test(line)));
});

test('a grant that never attaches stops blocking new starts after its grace period', async () => {
  let clock = 1_000;
  const registry = new VoiceSessionRegistry({ now: () => clock });
  const { methods } = createVoiceRpc({
    capabilities: capabilities(),
    registry,
    makeId: () => `vs-${clock}`,
  });

  await methods['voice.session.start']({ engine: 'local', thread }, ctx);
  // The start failed on the phone, the compensating stop never landed, and the
  // phone retries: while the grace period holds, the live grant still wins.
  await assert.rejects(
    () => methods['voice.session.start']({ engine: 'local', thread }, ctx),
    (error) => error.code === 'call_in_progress',
  );

  // A live attached session blocks only while it is actually alive: the phone
  // streams audio, so its lease is refreshed and the device stays taken.
  registry.create({ voiceSessionId: 'vs-live', deviceId: 'dev-1', engine: 'local', thread });
  registry.markAttached('vs-live');
  clock += 120_000;
  registry.markActivity('vs-live');
  await assert.rejects(
    () => methods['voice.session.start']({ engine: 'local', thread }, ctx),
    (error) => error.code === 'call_in_progress',
  );

  // The orphaned grant aged out; the live one, once ended, frees the device.
  registry.end('vs-live');
  const grant = await methods['voice.session.start']({ engine: 'local', thread }, ctx);
  assert.ok(grant.voiceSessionId);
});

// The first attempt attached its media socket, then was abandoned — the phone
// died, was killed, or never learned the start had failed. `markAttached` is a
// one-way latch and `voice.session.stop` never landed, so nothing was left to
// release the device: every later start was `call_in_progress` until the Gate
// process itself restarted. An attached session therefore needs a liveness
// lease, not just the grant-attach grace.
test('an attached call whose phone went silent frees the device, so a retry can start', async () => {
  let clock = 1_000;
  const registry = new VoiceSessionRegistry({ now: () => clock });
  let n = 0;
  const { methods } = createVoiceRpc({
    capabilities: capabilities(),
    registry,
    makeId: () => `vs-${(n += 1)}`,
  });

  const first = await methods['voice.session.start']({ engine: 'local', thread }, ctx);
  registry.markAttached(first.voiceSessionId);
  registry.markActivity(first.voiceSessionId);
  // The call is live, so it still holds the device.
  await assert.rejects(
    () => methods['voice.session.start']({ engine: 'local', thread }, ctx),
    (error) => error.code === 'call_in_progress',
  );

  // Then the phone vanished without ending the call and without saying so.
  clock += ATTACHED_LIVENESS_MS + 1;
  const retry = await methods['voice.session.start']({ engine: 'local', thread }, ctx);
  assert.ok(retry.voiceSessionId);
  assert.notEqual(retry.voiceSessionId, first.voiceSessionId);
});

test('an abandoned attached session is released with a named reason, not silently', async () => {
  let clock = 1_000;
  const registry = new VoiceSessionRegistry({ now: () => clock });
  registry.create({ voiceSessionId: 'vs-gone', deviceId: 'dev-1', engine: 'local', thread });
  registry.markAttached('vs-gone');

  assert.equal(registry.liveForDevice('dev-1').voiceSessionId, 'vs-gone');
  clock += ATTACHED_LIVENESS_MS + 1;
  assert.equal(registry.liveForDevice('dev-1'), null);
  assert.equal(registry.get('vs-gone').ended, true);
  assert.equal(registry.get('vs-gone').endedReason, 'abandoned');
});

// The guard on the fix: a long call is not an abandoned one. The phone streams
// mic audio continuously, so a healthy call refreshes its lease many times a
// second and must hold the device for as long as it lasts.
test('a long call that keeps sending audio never loses its reservation', async () => {
  let clock = 1_000;
  const registry = new VoiceSessionRegistry({ now: () => clock });
  const { methods } = createVoiceRpc({
    capabilities: capabilities(),
    registry,
    makeId: () => 'vs-long',
  });

  const grant = await methods['voice.session.start']({ engine: 'local', thread }, ctx);
  registry.markAttached(grant.voiceSessionId);
  // Forty minutes of conversation: audio every 250 ms, and the clock running.
  for (let elapsed = 250; elapsed <= 40 * 60_000; elapsed += 250) {
    clock = 1_000 + elapsed;
    registry.markActivity(grant.voiceSessionId);
  }
  await assert.rejects(
    () => methods['voice.session.start']({ engine: 'local', thread }, ctx),
    (error) => error.code === 'call_in_progress',
  );
  assert.equal(registry.get(grant.voiceSessionId).ended, false);
});
