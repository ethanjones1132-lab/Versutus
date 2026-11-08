import { test } from 'node:test';
import assert from 'node:assert/strict';

import { THRESHOLDS, evaluate, evaluateScenario, parseGfxinfo } from '../perf/gfxinfo.mjs';

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
    ...overrides,
  };
  return [
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
  ].join('\n');
}

test('parses totals, jank and percentiles, ignoring the legacy and gpu lines', () => {
  const run = parseGfxinfo(fixture());
  assert.equal(run.totalFrames, 600);
  assert.equal(run.jankyFrames, 12);
  assert.equal(run.jankyPct, 2);
  assert.equal(run.p50Ms, 6);
  assert.equal(run.p95Ms, 11);
  assert.equal(run.missedVsync, 0);
  assert.equal(run.deadlineMissed, 0);
});

test('throws on text that is not gfxinfo output', () => {
  assert.throws(() => parseGfxinfo('error: closed'), /not gfxinfo output/);
});

test('a clean run passes the bar', () => {
  const verdict = evaluate(parseGfxinfo(fixture()));
  assert.equal(verdict.pass, true);
  assert.deepEqual(verdict.failures, []);
  assert.ok(verdict.inBudgetPct >= THRESHOLDS.minInBudgetPct);
});

test('each limit fails on its own', () => {
  const janky = evaluate(parseGfxinfo(fixture({ janky: 60, jankyPct: '10.00' })));
  assert.equal(janky.pass, false);
  assert.match(janky.failures.join(' '), /frames in budget/);
  assert.match(janky.failures.join(' '), /janky/);

  const slow = evaluate(parseGfxinfo(fixture({ p95: 20 })));
  assert.equal(slow.pass, false);
  assert.match(slow.failures.join(' '), /p95/);

  const dropped = evaluate(parseGfxinfo(fixture({ deadline: 7, missed: 3 })));
  assert.equal(dropped.pass, false);
  assert.equal(dropped.droppedFrames, 7);
  assert.match(dropped.failures.join(' '), /dropped/);
});

test('a screen that rendered no frames is in budget by definition', () => {
  const verdict = evaluate(parseGfxinfo(fixture({ total: 0, janky: 0, jankyPct: '0.00', p95: 0 })));
  assert.equal(verdict.pass, true);
  assert.equal(verdict.inBudgetPct, 100);
});

test('a scenario passes only if every run passes', () => {
  const good = parseGfxinfo(fixture());
  const bad = parseGfxinfo(fixture({ p95: 25 }));
  assert.equal(evaluateScenario([good, good, good]).pass, true);
  assert.equal(evaluateScenario([good, bad, good]).pass, false);
});
