import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compareToBaseline, percentile, summarize } from '../voice-spikes/latency-harness.mjs';

test('percentile is exact on a known series', () => {
  const series = [10, 20, 30, 40, 50];
  assert.equal(percentile(series, 0), 10);
  assert.equal(percentile(series, 50), 30);
  assert.equal(percentile(series, 100), 50);
  assert.equal(percentile([10, 20, 30, 40], 50), 25);
  assert.equal(percentile([5], 90), 5);
  assert.equal(percentile([], 50), 0);
});

test('the latency samples turn into p50 and p95', () => {
  const samples = [
    { endOfSpeechAt: 1000, firstAudioAt: 1100 },
    { endOfSpeechAt: 2000, firstAudioAt: 2090 },
    { endOfSpeechAt: 3000, firstAudioAt: 3120 },
    { endOfSpeechAt: 4000, firstAudioAt: 4080 },
  ];
  assert.deepEqual(summarize(samples), { count: 4, p50: 95, p95: 117 });
});

test('a measurement within tolerance passes and a worse p95 regresses', () => {
  const baseline = { p50: 100, p95: 200 };
  const tolerance = 0.2;

  const ok = compareToBaseline({ p50: 110, p95: 230 }, baseline, tolerance);
  assert.equal(ok.regressed, false);

  const slowP95 = compareToBaseline({ p50: 100, p95: 241 }, baseline, tolerance);
  assert.equal(slowP95.regressed, true);

  const slowP50 = compareToBaseline({ p50: 121, p95: 200 }, baseline, tolerance);
  assert.equal(slowP50.regressed, true);
});
