import test from 'node:test';
import assert from 'node:assert/strict';

import { AUDIT_FIELDS, buildAuditLine } from '../core/voice/audit.mjs';
import { latencyMedian, latencyPercentile } from '../core/voice/media-socket.mjs';

const LATENCY_FIELDS = [
  'p50EosToCommitMs', 'p90EosToCommitMs',
  'p50DecodeMs', 'p90DecodeMs',
  'p50FirstReplyMs', 'p90FirstReplyMs',
  'p50SentenceToPcmMs', 'p90SentenceToPcmMs',
  'p50PlayedMs', 'p90PlayedMs',
];

test('audit schema includes every O1 per-turn measure as flat scalar p50/p90 fields', () => {
  const line = buildAuditLine({});
  for (const field of LATENCY_FIELDS) {
    assert.ok(AUDIT_FIELDS.includes(field), `${field} is allowed by the closed audit schema`);
    assert.equal(line[field], null, `${field} is present even before a sample exists`);
  }
  assert.deepEqual(Object.keys(line).filter((key) => LATENCY_FIELDS.includes(key)).sort(), [...LATENCY_FIELDS].sort());
});

test('call latency p50 and p90 use nearest-rank samples and null for no turns', () => {
  const samples = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  assert.equal(latencyMedian(samples), 55);
  assert.equal(latencyPercentile(samples, 0.9), 90);
  assert.equal(latencyPercentile([], 0.9), null);
});
