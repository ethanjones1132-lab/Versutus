import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AUDIT_FIELDS, buildAuditLine, createVoiceAudit } from '../core/voice/audit.mjs';

test('the audit line has exactly the documented fields', () => {
  const line = buildAuditLine({
    ts: '2026-09-13T00:00:00.000Z',
    deviceId: 'dev-1',
    botId: 'scout',
    engine: 'local',
    fellBackFrom: 'codex',
    turns: 3,
    secondsListening: 12.5,
    secondsSpeaking: 7,
    p50FirstAudioMs: 900,
    error: null,
  });
  assert.deepEqual(Object.keys(line).sort(), [...AUDIT_FIELDS].sort());
  assert.equal(line.botId, 'scout');
  assert.equal(line.engine, 'local');
});

test('a summary cannot smuggle transcript text into the line', () => {
  const line = buildAuditLine({
    deviceId: 'dev-1',
    engine: 'local',
    text: 'send the invoice',
    partial: 'send the',
    reply: 'the invoice was sent',
    transcript: 'secret words',
    nested: { text: 'also secret' },
  });
  const serialized = JSON.stringify(line);
  for (const secret of [
    'send the invoice',
    'send the',
    'the invoice was sent',
    'secret words',
    'also secret',
  ]) {
    assert.equal(serialized.includes(secret), false, `leaked: ${secret}`);
  }
});

test('missing fields are null and a turn count defaults to zero', () => {
  const line = buildAuditLine({ deviceId: 'dev-1' });
  assert.equal(line.turns, 0);
  assert.equal(line.botId, null);
  assert.equal(line.engine, null);
  assert.equal(line.error, null);
});

test('the sink appends one JSON line per call and creates the directory', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'voice-audit-')), 'nested');
  const audit = createVoiceAudit({ dir, now: () => '2026-09-13T00:00:00.000Z' });
  audit.record({ deviceId: 'dev-1', engine: 'local' });
  audit.record({ deviceId: 'dev-1', engine: 'phone', error: 'network' });

  const lines = readFileSync(join(dir, 'audit.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).ts, '2026-09-13T00:00:00.000Z');
  assert.equal(JSON.parse(lines[0]).engine, 'local');
  assert.equal(JSON.parse(lines[1]).error, 'network');
});
