import { test } from 'node:test';
import assert from 'node:assert/strict';

import { THRESHOLDS, evaluate, evaluateScenario, parseGfxinfo, parseHistogram } from '../perf/gfxinfo.mjs';

/** Builds gfxinfo text. `hist` is { ms: count }; the default is 600 frames, 98.3% at or under 16 ms. */
function fixture(overrides = {}) {
  const v = {
    total: 600,
    janky: 12,
    jankyPct: '2.00',
    p50: 6,
    p90: 9,
    p95: 11,
    p99: 19,
    missed: 0,
    uiSlow: 5,
    deadline: 0,
    hist: { 8: 100, 12: 400, 16: 90, 17: 10 },
    ...overrides,
  };
  const lines = [
    'Applications Graphics Acceleration Info:',
    'Uptime: 123456 Realtime: 123456',
    '',
    '** Graphics info for pid 4242 [com.versutus.app] **',
    '',
    'Stats since: 123456789ns',
    `Total frames rendered: ${v.total}`,
    `Janky frames: ${v.janky} (${v.jankyPct}%)`,
    'Janky frames (legacy): 20 (3.33%)',
    `50th percentile: ${v.p50}ms`,
    `90th percentile: ${v.p90}ms`,
    `95th percentile: ${v.p95}ms`,
    `99th percentile: ${v.p99}ms`,
    '50th gpu percentile: 3ms',
    `Number Missed Vsync: ${v.missed}`,
    'Number High input latency: 0',
    `Number Slow UI thread: ${v.uiSlow}`,
    'Number Slow bitmap uploads: 0',
    'Number Slow issue draw commands: 2',
    `Number Frame deadline missed: ${v.deadline}`,
  ];
  if (v.hist) {
    lines.push(`HISTOGRAM: ${Object.entries(v.hist).map(([ms, n]) => `${ms}ms=${n}`).join(' ')}`);
    lines.push('GPU HISTOGRAM: 1ms=0 2ms=3 3ms=42');
  }
  return lines.join('\n');
}

test('parses totals, jank, percentiles and the frame-time histogram', () => {
  const run = parseGfxinfo(fixture());
  assert.equal(run.totalFrames, 600);
  assert.equal(run.jankyFrames, 12);
  assert.equal(run.jankyPct, 2);
  assert.equal(run.p50Ms, 6);
  assert.equal(run.p95Ms, 11);
  assert.equal(run.missedVsync, 0);
  assert.equal(run.deadlineMissed, 0);
  assert.deepEqual(run.histogram, [[8, 100], [12, 400], [16, 90], [17, 10]]);
});

test('the histogram parser ignores the GPU histogram and returns nothing when there is none', () => {
  assert.deepEqual(parseHistogram('GPU HISTOGRAM: 1ms=5'), []);
  assert.deepEqual(parseHistogram('HISTOGRAM: 5ms=1 6ms=2\r\nGPU HISTOGRAM: 1ms=9'), [[5, 1], [6, 2]]);
});

test('throws on text that is not gfxinfo output', () => {
  assert.throws(() => parseGfxinfo('error: closed'), /not gfxinfo output/);
});

test('a clean run passes the bar', () => {
  const verdict = evaluate(parseGfxinfo(fixture()));
  assert.equal(verdict.pass, true);
  assert.deepEqual(verdict.failures, []);
  assert.ok(verdict.inBudgetPct >= THRESHOLDS.minInBudgetPct);
  assert.equal(verdict.droppedFrames, 0);
});

test('each limit fails on its own', () => {
  const slow = evaluate(parseGfxinfo(fixture({ hist: { 12: 300, 20: 300 }, p95: 20 })));
  assert.equal(slow.pass, false);
  assert.match(slow.failures.join(' '), /frames in budget 50\.0%/);
  assert.match(slow.failures.join(' '), /p95/);

  const dropped = evaluate(parseGfxinfo(fixture({ hist: { 12: 590, 40: 10 } })));
  assert.equal(dropped.pass, false);
  assert.equal(dropped.droppedFrames, 10);
  assert.match(dropped.failures.join(' '), /10 dropped frames of 600/);
});

test('on a 120 Hz display gfxinfo calls most smooth 60 fps frames janky; the verdict ignores that', () => {
  const verdict = evaluate(parseGfxinfo(fixture({ janky: 480, jankyPct: '80.00' })));
  assert.equal(verdict.pass, true);
});

test('16 ms is in budget and 17 ms is not', () => {
  assert.equal(evaluate(parseGfxinfo(fixture({ hist: { 16: 95, 17: 5 } }))).pass, true);
  const over = evaluate(parseGfxinfo(fixture({ hist: { 16: 94, 17: 6 } })));
  assert.equal(over.pass, false);
  assert.match(over.failures.join(' '), /frames in budget 94\.0%/);
});

test('a screen that rendered no frames is in budget by definition', () => {
  const verdict = evaluate(parseGfxinfo(fixture({ total: 0, janky: 0, jankyPct: '0.00', p95: 0, hist: {} })));
  assert.equal(verdict.pass, true);
  assert.equal(verdict.inBudgetPct, 100);
});

test('frames with no histogram cannot be judged', () => {
  const verdict = evaluate(parseGfxinfo(fixture({ hist: null })));
  assert.equal(verdict.pass, false);
  assert.match(verdict.failures.join(' '), /no frame-time histogram/);
});

test('a scenario passes only if every run passes', () => {
  const good = parseGfxinfo(fixture());
  const bad = parseGfxinfo(fixture({ hist: { 12: 300, 40: 300 }, p95: 40 }));
  assert.equal(evaluateScenario([good, good, good]).pass, true);
  assert.equal(evaluateScenario([good, bad, good]).pass, false);
});
