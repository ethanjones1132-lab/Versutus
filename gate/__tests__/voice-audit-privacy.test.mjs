// Voice privacy (S3, S4, D6): neither the Gate log nor the audit line holds a
// raw device id or the words of an untrusted error, and the audit rotates so a
// month of calls is the whole retention. Every case is hermetic: temp dirs or a
// loopback socket, the real sink, and an injected clock or size bound for the
// two rotation triggers.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WebSocket } from 'ws';

import {
  AUDIT_MAX_AGE_MS,
  buildAuditLine,
  createVoiceAudit,
  deviceTag,
} from '../core/voice/audit.mjs';
import { VOICE_STREAM_PATH, attachVoiceMediaSocket } from '../core/voice/media-socket.mjs';
import { VoiceSessionRegistry, createVoiceRpc } from '../core/voice/voice-rpc.mjs';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'voice-audit-privacy-'));
}

function readLines(path) {
  return readFileSync(path, 'utf8').trim().split('\n');
}

async function waitUntil(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition');
    await new Promise((done) => setTimeout(done, 5));
  }
}

/**
 * The smallest real call: one controllable engine, one socket, and the real
 * media socket writing to this test's collectors. What the test emits is what
 * the Gate hears, so every logging path can be exercised without a model.
 */
async function startPrivacyCall(t, { runTurn } = {}) {
  const registry = new VoiceSessionRegistry();
  registry.create({ voiceSessionId: 'vs-privacy', deviceId: 'device-1', engine: 'local' });
  const listeners = new Map();
  const engine = {
    open: async () => {},
    pushAudio() {},
    close() {},
    spoken: [],
    cancelled: [],
    on: (event, fn) => {
      listeners.set(event, fn);
      return engine;
    },
    emit: (event, payload) => listeners.get(event)?.(payload),
    speak: (text, { gen } = {}) => engine.spoken.push({ text, gen }),
    cancelSpeech: (gen) => engine.cancelled.push(gen),
  };
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const lines = [];
  const audit = [];
  const wss = attachVoiceMediaSocket({
    server,
    deviceTokens: {
      verify: async (authorization) => (authorization === 'Bearer tok-1' ? { deviceId: 'device-1' } : null),
    },
    registry,
    createEngine: () => engine,
    runTurn,
    audit: (summary) => audit.push(summary),
    log: (line) => lines.push(line),
    utteranceHoldMs: 0,
  });
  server.listen(0);
  await once(server, 'listening');
  t.after(
    () => new Promise((done) => {
      for (const client of wss.clients) client.terminate();
      wss.close(() => server.close(done));
    }),
  );
  const frames = [];
  const ws = new WebSocket(
    `ws://127.0.0.1:${server.address().port}${VOICE_STREAM_PATH}?voiceSessionId=vs-privacy`,
    { headers: { Authorization: 'Bearer tok-1' } },
  );
  ws.on('message', (data, isBinary) => {
    if (!isBinary) frames.push(JSON.parse(data.toString()));
  });
  await once(ws, 'open');
  await waitUntil(() => frames.some((frame) => frame.t === 'ready'));
  return { ws, frames, lines, audit, engine };
}

function capabilities() {
  return () => ({
    enabled: true,
    engines: {
      local: { state: 'ready' },
      codex: { state: 'disabled', reason: 'Codex realtime needs an API key' },
    },
    limits: { maxConcurrentCalls: 1 },
  });
}

const thread = { kind: 'bot', sessionId: 's1', botId: 'scout' };

// ─── No raw id, in the log or in the audit ───────────────────────────────

test('a whole scripted session names the phone only by its tag', async () => {
  const rawId = 'device-raw-7f3a9c2e';
  const lines = [];
  let ids = 0;
  const { methods, registry } = createVoiceRpc({
    capabilities: capabilities(),
    makeId: () => `vs-${(ids += 1)}`,
    log: (line) => lines.push(line),
  });
  const dir = tempDir();
  const audit = createVoiceAudit({ dir, now: () => '2026-11-10T00:00:00.000Z' });

  await methods['voice.capabilities']({}, { deviceId: rawId });
  const grant = await methods['voice.session.start']({ engine: 'auto', thread }, { deviceId: rawId });
  // A refused start is still logged, and it must be tagged too. It is the one
  // path that has no canonical id yet and logs the attempt's claim instead.
  await assert.rejects(
    () => methods['voice.session.start']({ engine: 'auto', thread }, { deviceId: rawId }),
    (error) => error.code === 'call_in_progress',
  );
  await methods['voice.session.stop'](
    { voiceSessionId: grant.voiceSessionId },
    { deviceId: rawId },
  );

  // The audit is handed the raw id the media socket holds, exactly as in a call.
  audit.record({
    deviceId: registry.get(grant.voiceSessionId).deviceId,
    botId: 'scout',
    engine: 'local',
    turns: 1,
  });

  assert.ok(lines.length >= 5, 'the session wrote a line for every step');
  for (const line of lines) {
    assert.equal(line.includes(rawId), false, `raw device id in log line: ${line}`);
  }
  const tag = deviceTag(rawId);
  const deviceFields = lines.filter((line) => line.includes('device='));
  assert.ok(deviceFields.length >= 4, 'every step names the phone');
  assert.ok(
    deviceFields.every((line) => line.includes(`device=${tag}`)),
    'every device field carries the one shared tag',
  );

  const auditLine = JSON.parse(readLines(join(dir, 'audit.jsonl'))[0]);
  assert.equal(auditLine.deviceTag, tag, 'the audit uses the same tag as the log');
  assert.equal('deviceId' in auditLine, false, 'the raw field is gone, not renamed around');
  assert.equal(JSON.stringify(auditLine).includes(rawId), false);
});

test('the audit line tags a raw id and drops a non-scalar one', () => {
  const rawId = 'device-raw-7f3a9c2e';
  assert.equal(buildAuditLine({ deviceId: rawId }).deviceTag, deviceTag(rawId));
  assert.equal(
    buildAuditLine({ deviceTag: deviceTag(rawId) }).deviceTag,
    deviceTag(rawId),
    'an already-tagged summary is passed through',
  );
  assert.equal(buildAuditLine({ deviceId: { text: 'not an id' } }).deviceTag, null);
  assert.equal(buildAuditLine({}).deviceTag, null);
});

// ─── Rotation: by age and by size, one prior file ────────────────────────

test('an audit whose oldest line is past the retention rotates before appending', () => {
  const dir = tempDir();
  const path = join(dir, 'audit.jsonl');
  const prior = `${path}.1`;
  const oldLine = JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', engine: 'local' });
  writeFileSync(prior, 'a prior file that is replaced\n');
  writeFileSync(path, `${oldLine}\n`);

  const audit = createVoiceAudit({ dir, now: () => '2026-02-15T00:00:00.000Z' });
  assert.equal(audit.record({ deviceId: 'dev-1', engine: 'phone' }), true);

  // The month-old file moved aside and the .1 it replaced is gone: the Gate
  // keeps one prior file, never two.
  assert.deepEqual(readLines(prior), [oldLine]);
  const current = readLines(path);
  assert.equal(current.length, 1, 'the new call starts a fresh file');
  assert.equal(JSON.parse(current[0]).engine, 'phone');
});

test('an audit inside its retention is appended to, not rotated', () => {
  const dir = tempDir();
  const path = join(dir, 'audit.jsonl');
  writeFileSync(
    path,
    `${JSON.stringify({ ts: '2026-02-01T00:00:00.000Z', engine: 'local' })}\n`,
  );

  const audit = createVoiceAudit({ dir, now: () => '2026-02-15T00:00:00.000Z' });
  audit.record({ engine: 'phone' });

  assert.equal(existsSync(`${path}.1`), false, 'a fresh file is not moved');
  assert.equal(readLines(path).length, 2, 'the line joins the file it found');
});

test('an audit past the size bound rotates and keeps at most one prior file', () => {
  const dir = tempDir();
  const path = join(dir, 'audit.jsonl');
  const audit = createVoiceAudit({
    dir,
    maxBytes: 40,
    now: () => '2026-11-10T00:00:00.000Z',
  });

  audit.record({ engine: 'local', turns: 1 });
  assert.equal(existsSync(`${path}.1`), false, 'the first line has nothing to rotate');

  audit.record({ engine: 'phone', turns: 2 });
  audit.record({ engine: 'local', turns: 3 });

  const current = readLines(path);
  const prior = readLines(`${path}.1`);
  assert.equal(current.length, 1);
  assert.equal(prior.length, 1);
  assert.equal(JSON.parse(current[0]).turns, 3);
  assert.equal(JSON.parse(prior[0]).turns, 2, 'the newest prior file is the one kept');
});

test('a rotation that fails still writes the line and is reported once', () => {
  const dir = tempDir();
  const path = join(dir, 'audit.jsonl');
  writeFileSync(
    path,
    `${JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', engine: 'local' })}\n`,
  );
  const reported = [];
  const audit = createVoiceAudit({
    dir,
    now: () => '2026-02-15T00:00:00.000Z',
    rotateFile: () => {
      throw new Error('EPERM: audit is locked');
    },
    log: (line) => reported.push(line),
  });

  // The reducer records on the way out of a call: housekeeping failing must not
  // stop the terminal frames, and the line the call needed still lands.
  assert.doesNotThrow(() => {
    assert.equal(audit.record({ engine: 'phone', error: 'network' }), true);
    assert.equal(audit.record({ engine: 'local' }), true);
  });
  assert.equal(readLines(path).length, 3);
  assert.equal(existsSync(`${path}.1`), false, 'nothing was moved');
  assert.equal(reported.length, 1, 'one report per failure, not one per call');
  assert.match(reported[0], /^voice\.audit rotate failed reason=EPERM/);
  assert.equal(
    reported[0].includes('audit is locked'),
    false,
    'the filesystem message can name a path, so only its code is logged',
  );
});

test('the audit retention is 30 days, as D6 states', () => {
  assert.equal(AUDIT_MAX_AGE_MS, 30 * 24 * 60 * 60 * 1000);
});

// ─── Untrusted error text never reaches a log or the audit ───────────────

test('an audit error that is not one of the Gate’s end reasons is reduced to its size', () => {
  const secret = 'backend said: the transcript asked what is my balance';
  const line = buildAuditLine({ error: secret });
  assert.match(line.error, /^redacted chars=\d+$/);
  assert.equal(JSON.stringify(line).includes('balance'), false);
  assert.equal(buildAuditLine({ error: 'network' }).error, 'network');
  assert.equal(buildAuditLine({}).error, null);
  assert.equal(buildAuditLine({ error: { text: secret } }).error, null);
});

test('a backend failure is logged by size, never by the words it failed on', async (t) => {
  const secret = 'the operator said my account number is 4417 and my postcode is EH1 1AA';
  const { ws, frames, lines, audit, engine } = await startPrivacyCall(t, {
    runTurn: async () => {
      throw new Error(secret);
    },
  });

  engine.emit('final', { text: 'what is the weather' });
  const failure = await waitUntil(() => lines.find((line) => /^voice\.turn fail /.test(line)));
  assert.match(failure, /reason=redacted chars=\d+/);
  assert.ok(failure.includes(`chars=${secret.length}`), 'the size is what a log may keep');
  assert.equal(failure.includes('4417'), false);
  assert.equal(failure.includes('postcode'), false);

  // The phone still learns the turn failed; the dropped words are the
  // backend's account of why, not anything the operator said.
  await waitUntil(() => frames.some((frame) => frame.t === 'turn' && frame.state === 'failed'));

  const closed = once(ws, 'close');
  ws.send(JSON.stringify({ t: 'end' }));
  await waitUntil(() => audit.length === 1);
  await closed;
  assert.equal(JSON.stringify(audit[0]).includes('4417'), false);
  assert.equal(audit[0].error, 'user');
});

test('an engine error is logged by size, never by its words', async (t) => {
  const secret = 'worker traceback: the prompt asked what is my balance';
  const { ws, lines, engine } = await startPrivacyCall(t, {
    runTurn: async () => ({ hasContent: true }),
  });

  engine.emit('error', { code: 'engine_failed', message: secret });
  const event = await waitUntil(() => lines.find((line) => /^voice\.event .*type=error/.test(line)));
  assert.match(event, /code=engine_failed/);
  assert.match(event, /message=redacted chars=\d+/);
  assert.equal(event.includes('balance'), false);

  const closed = once(ws, 'close');
  ws.close();
  await closed;
});

test('a refused start logs its reason by size, never by the words in it', async () => {
  const secret = 'The PC voice models are missing from C:\\Users\\operator\\transcript.txt';
  const lines = [];
  const { methods } = createVoiceRpc({
    capabilities: () => ({
      enabled: true,
      engines: { local: { state: 'not-installed', reason: secret } },
      limits: { maxConcurrentCalls: 1 },
    }),
    log: (line) => lines.push(line),
  });

  await assert.rejects(
    () => methods['voice.session.start'](
      { engine: 'auto', thread },
      { deviceId: 'device-raw-7f3a9c2e' },
    ),
    (error) => error.code === 'no_engine',
  );

  const failure = lines.find((line) => /voice\.session\.start fail/.test(line));
  assert.ok(failure, 'the refused start was logged');
  assert.match(failure, /reason=redacted chars=\d+/);
  assert.equal(failure.includes('transcript.txt'), false);
  assert.equal(failure.includes('device-raw'), false);
});
