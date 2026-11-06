import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ATTACHED_LIVENESS_MS, createVoiceRpc, VoiceSessionRegistry } from '../core/voice/voice-rpc.mjs';

const thread = { kind: 'bot', sessionId: 's1', botId: 'b1' };

function capabilities(maxConcurrentCalls = 1) {
  return () => ({
    enabled: true,
    engines: { local: { state: 'ready' }, codex: { state: 'disabled' } },
    limits: { maxConcurrentCalls },
  });
}

test('voice call capacity is global, released on end, and preserves the active call', async () => {
  let id = 0;
  const backendLeases = [];
  const { methods, registry } = createVoiceRpc({
    capabilities: capabilities(),
    makeId: () => `vs-${++id}`,
    prepareCallBackend: (call) => {
      backendLeases.push(call);
      return null;
    },
  });
  const start = (deviceId) => methods['voice.session.start']({ thread }, { deviceId });

  const a = await start('device-a');
  assert.equal(registry.liveForDevice('device-a').voiceSessionId, a.voiceSessionId);
  await assert.rejects(start('device-a'), (error) => error.code === 'call_in_progress' && error.status === 409);

  await assert.rejects(start('device-b'), (error) => {
    assert.equal(error.code, 'voice_busy');
    assert.equal(error.status, 409);
    assert.equal(error.message, 'Another device is on a call with this Gate.');
    return true;
  });
  assert.equal(registry.liveForDevice('device-a').voiceSessionId, a.voiceSessionId);
  assert.equal(registry.liveForDevice('device-b'), null);
  assert.equal(backendLeases.length, 1, 'a refused start must not prepare a call backend');

  await methods['voice.session.stop']({ voiceSessionId: a.voiceSessionId }, { deviceId: 'device-a' });
  const b = await start('device-b');
  assert.equal(registry.liveForDevice('device-b').voiceSessionId, b.voiceSessionId);
});

test('capacity is read from the advertised limit, not hard-coded', async () => {
  let id = 0;
  const { methods } = createVoiceRpc({
    capabilities: capabilities(2),
    makeId: () => `vs-${++id}`,
  });

  await methods['voice.session.start']({ thread }, { deviceId: 'device-a' });
  await methods['voice.session.start']({ thread }, { deviceId: 'device-b' });
  await assert.rejects(
    () => methods['voice.session.start']({ thread }, { deviceId: 'device-c' }),
    (error) => error.code === 'voice_busy' && error.status === 409,
  );
});

test('an abandoned call on another device is ended and frees global capacity', async () => {
  let clock = 1_000;
  let id = 0;
  const registry = new VoiceSessionRegistry({ now: () => clock });
  const { methods } = createVoiceRpc({
    capabilities: capabilities(),
    registry,
    makeId: () => `vs-${++id}`,
  });

  const a = await methods['voice.session.start']({ thread }, { deviceId: 'device-a' });
  registry.markAttached(a.voiceSessionId);
  clock += ATTACHED_LIVENESS_MS + 1;
  const b = await methods['voice.session.start']({ thread }, { deviceId: 'device-b' });

  assert.equal(registry.get(a.voiceSessionId).ended, true);
  assert.equal(registry.get(a.voiceSessionId).endedReason, 'abandoned');
  assert.equal(registry.liveForDevice('device-b').voiceSessionId, b.voiceSessionId);
});
