// Voice privacy (S4, D6): neither the Gate log nor the audit line holds a raw
// device id, and the audit rotates so a month of calls is the whole retention.
// Every case is hermetic: temp dirs, the real sink, and an injected clock or
// size bound for the two rotation triggers.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildAuditLine, createVoiceAudit, deviceTag } from '../core/voice/audit.mjs';
import { createVoiceRpc } from '../core/voice/voice-rpc.mjs';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'voice-audit-privacy-'));
}

function readLines(path) {
  return readFileSync(path, 'utf8').trim().split('\n');
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
});
