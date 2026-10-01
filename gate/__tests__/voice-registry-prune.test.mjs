import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { WebSocket } from 'ws';

import {
  ATTACHED_LIVENESS_MS,
  GRANT_ATTACH_GRACE_MS,
  VoiceSessionRegistry,
} from '../core/voice/voice-rpc.mjs';
import { VOICE_STREAM_PATH, attachVoiceMediaSocket } from '../core/voice/media-socket.mjs';

const thread = { kind: 'bot', sessionId: 's1', botId: 'scout' };
const endedRecords = (registry) => [...registry.sessions.values()].filter((s) => s.ended);

function grant(registry, voiceSessionId, deviceId = 'dev-1') {
  registry.create({ voiceSessionId, deviceId, engine: 'local', thread });
  return voiceSessionId;
}

// Every call, failed start and never-attached grant used to stay in the map for
// the life of the Gate, each holding the thread the phone sent. `end()` keeps the
// record — a late media upgrade has to be able to find it and be refused — but
// nothing on it is needed once the call is over, and the record itself has to go.
// The default cap is 200 ended records (voice-rpc's MAX_ENDED_SESSIONS).
test('an ended session drops the phone thread it was holding', () => {
  const registry = new VoiceSessionRegistry();
  grant(registry, 'vs-1');
  assert.equal(registry.get('vs-1').thread, thread);

  assert.equal(registry.end('vs-1', 'user'), true);
  const ended = registry.get('vs-1');
  assert.equal(ended.ended, true);
  assert.equal(ended.endedReason, 'user');
  assert.equal(ended.thread, undefined, 'the record stops holding the phone payload');
  // Everything the media socket reads for an ended session is still there.
  assert.equal(ended.voiceSessionId, 'vs-1');
  assert.equal(ended.deviceId, 'dev-1');
  assert.equal(ended.engine, 'local');
});

test('the end fan-out still sees the thread, so the audit line keeps its botId', () => {
  const registry = new VoiceSessionRegistry();
  grant(registry, 'vs-1');
  const seen = [];
  registry.onEnd((session, reason) => seen.push({ botId: session.thread?.botId ?? null, reason }));

  registry.end('vs-1', 'abandoned');
  assert.deepEqual(seen, [{ botId: 'scout', reason: 'abandoned' }]);
  assert.equal(registry.get('vs-1').thread, undefined);
});

test('an ended record is still answerable inside its retention window and gone after it', () => {
  let clock = 1_000;
  const registry = new VoiceSessionRegistry({ now: () => clock, endedRetentionMs: 60_000 });
  grant(registry, 'vs-1');
  registry.end('vs-1', 'user');

  clock += 59_000;
  registry.liveForDevice('dev-9');
  assert.equal(registry.get('vs-1')?.ended, true, 'inside the window the record still answers');

  clock += 2_000;
  registry.liveForDevice('dev-9');
  assert.equal(registry.get('vs-1'), null, 'past the window it is gone');
});

test('the ended cap evicts the oldest ended record first', () => {
  let clock = 1_000;
  const registry = new VoiceSessionRegistry({ now: () => clock, maxEndedSessions: 3 });
  for (const id of ['vs-1', 'vs-2', 'vs-3', 'vs-4']) {
    grant(registry, id, `dev-${id}`);
    registry.end(id, 'user');
    clock += 10;
    // The cap holds the moment a call ends, not only after the next start.
    assert.ok(endedRecords(registry).length <= 3, `cap held after ${id}`);
  }
  assert.equal(endedRecords(registry).length, 3);
  assert.equal(registry.get('vs-1'), null, 'the first ended went first');
  assert.equal(registry.get('vs-2').ended, true);
  assert.equal(registry.get('vs-4').ended, true, 'the newest is still answerable');
});

test('a live session is never pruned, however old it is', () => {
  let clock = 1_000;
  const registry = new VoiceSessionRegistry({ now: () => clock, endedRetentionMs: 1_000, maxEndedSessions: 1 });
  grant(registry, 'vs-live');
  registry.markAttached('vs-live');
  for (const id of ['vs-dead-1', 'vs-dead-2', 'vs-dead-3']) {
    grant(registry, id, `dev-${id}`);
    registry.end(id, 'user');
  }

  clock += 10 * 60_000;
  registry.markActivity('vs-live');
  assert.equal(registry.liveForDevice('dev-1').voiceSessionId, 'vs-live');
  assert.equal(registry.get('vs-live').ended, false);
  assert.equal(registry.get('vs-dead-1'), null, 'every ended record aged out');
  assert.equal(registry.get('vs-dead-3'), null);
  assert.equal(registry.sessions.size, 1, 'only the live record is left');
});

test('a thousand calls and ends leave the registry at the cap', () => {
  const registry = new VoiceSessionRegistry({ now: () => 1_000 });
  for (let i = 0; i < 1_000; i += 1) {
    grant(registry, `vs-${i}`);
    registry.end(`vs-${i}`, 'user');
  }
  assert.equal(registry.sessions.size, 200);
  assert.equal(endedRecords(registry).length, 200);
  assert.equal(registry.get('vs-0'), null, 'the oldest ended went first');
  assert.equal(registry.get('vs-999').ended, true, 'the newest is still answerable');
  assert.equal(registry.liveForDevice('dev-1'), null);
});

// The semantics of `liveForDevice` are unchanged; only what it walks to find
// them is. A lapsed grant and an abandoned call are still ended (not skipped), so
// the late socket that names them is refused instead of running beside the
// replacement.
test('a lapsed grant and an abandoned call are ended, and the live one is returned', () => {
  let clock = 1_000;
  const registry = new VoiceSessionRegistry({ now: () => clock });
  grant(registry, 'vs-grant');
  grant(registry, 'vs-live');
  registry.markAttached('vs-live');

  assert.equal(registry.liveForDevice('dev-1').voiceSessionId, 'vs-grant');

  clock += GRANT_ATTACH_GRACE_MS + 1;
  assert.equal(registry.liveForDevice('dev-1').voiceSessionId, 'vs-live');
  assert.equal(registry.get('vs-grant').endedReason, 'expired');

  clock += ATTACHED_LIVENESS_MS + 1;
  assert.equal(registry.liveForDevice('dev-1'), null);
  assert.equal(registry.get('vs-live').endedReason, 'abandoned');
  assert.equal(registry.liveForDevice('dev-1'), null, 'an ended record never answers as live');
});

test('another device\'s ended records never answer for this one', () => {
  const registry = new VoiceSessionRegistry();
  grant(registry, 'vs-1', 'dev-1');
  registry.end('vs-1', 'user');
  assert.equal(registry.liveForDevice('dev-1'), null);
  assert.equal(registry.liveForDevice('dev-2'), null);
});

// The media socket is the only reader of an ended record, and its upgrade path
// branches on `session.ended` — which is why the record outlives the call. Once
// the record is pruned the path must land on the same answer an unknown id gets,
// or a late phone would be told "not found" for a session and something else for
// the next one.
test('a pruned session is refused by the media socket exactly as an unknown id', async () => {
  let clock = 1_000;
  const registry = new VoiceSessionRegistry({ now: () => clock, endedRetentionMs: 1_000 });
  grant(registry, 'vs-old');
  registry.end('vs-old', 'user');
  const media = await startMedia(registry);

  try {
    await assert.rejects(() => openStream(media.port, 'vs-old'), /409/, 'inside the window: ended');

    clock += 2_000;
    registry.liveForDevice('dev-1');
    await assert.rejects(() => openStream(media.port, 'vs-old'), /404/, 'pruned: unknown');
    await assert.rejects(() => openStream(media.port, 'never-existed'), /404/, 'unknown id');
  } finally {
    await media.close();
  }
});

// The media socket writes its audit line from the terminal event it dispatches
// inside its own `end()` — which the registry triggers from its end fan-out, not
// after it. So the payload is dropped on the correct side of that fan-out, and
// the line still names the Bot the call was talking to.
test('a released reservation still audits the Bot the call was talking to', async () => {
  let clock = 1_000;
  const registry = new VoiceSessionRegistry({ now: () => clock });
  grant(registry, 'vs-1');
  const audit = [];
  const media = await startMedia(registry, { audit: (line) => audit.push(line) });
  try {
    await connectStream(media.port, 'vs-1');
    // The phone is gone: not one more frame in either direction.
    clock += ATTACHED_LIVENESS_MS + 1;
    assert.equal(registry.liveForDevice('dev-1'), null);
    const line = await waitUntil(() => audit[0]);
    assert.equal(line.botId, 'scout');
    assert.equal(line.deviceId, 'dev-1');
    assert.equal(registry.get('vs-1').thread, undefined);
  } finally {
    await media.close();
  }
});

// ─── the media socket the upgrade assertions above need ──────────────────

async function waitUntil(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition');
    await new Promise((done) => setTimeout(done, 10));
  }
}

function startMedia(registry, options = {}) {
  const deviceTokens = {
    verify: async (authorization) => (authorization === 'Bearer tok-1' ? { deviceId: 'dev-1' } : null),
  };
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const wss = attachVoiceMediaSocket({
    server,
    deviceTokens,
    registry,
    createEngine: () => ({
      open: async () => {},
      pushAudio() {},
      close() {},
      on() {},
    }),
    ...options,
  });
  server.listen(0);
  return once(server, 'listening').then(() => ({
    port: server.address().port,
    close: () =>
      new Promise((done) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => server.close(done));
      }),
  }));
}

function streamUrl(port, voiceSessionId) {
  return `ws://127.0.0.1:${port}${VOICE_STREAM_PATH}?voiceSessionId=${voiceSessionId}`;
}

/** A refused upgrade arrives as an error carrying the HTTP status; an accepted
 *  one is the failure, so it resolves with an error to say so. */
function openStream(port, voiceSessionId) {
  const ws = new WebSocket(streamUrl(port, voiceSessionId), {
    headers: { Authorization: 'Bearer tok-1' },
  });
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(new Error('the upgrade was accepted')));
    ws.once('error', reject);
  });
}

/** The same upgrade, expected to be accepted. */
function connectStream(port, voiceSessionId) {
  const ws = new WebSocket(streamUrl(port, voiceSessionId), {
    headers: { Authorization: 'Bearer tok-1' },
  });
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}