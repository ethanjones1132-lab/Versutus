/**
 * Reads `adb shell dumpsys gfxinfo <package>` text and judges it against the
 * ambient-redesign performance bar (docs/superpowers/specs/2026-11-07-ambient-redesign-design.md,
 * section 7). Pure helpers are unit-tested; `main` is the command-line entry
 * that scripts/perf/run-scenario.ps1 calls.
 *
 * Usage: node scripts/perf/gfxinfo.mjs --file run1.txt [--file run2.txt ...] [--check]
 * `--check` exits 1 when any run misses the bar.
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * The bar, in one place. gfxinfo reports percentiles in whole milliseconds, so
 * a p95 under 16.7 ms reads as 16 or less.
 */
export const THRESHOLDS = Object.freeze({
  minInBudgetPct: 95,
  maxJankyPct: 5,
  maxP95Ms: 16.7,
  maxDroppedFrames: 0,
});

function intAfter(text, label) {
  const match = text.match(new RegExp(`${label}:\\s*(\\d+)`));
  return match ? Number(match[1]) : null;
}

function percentileMs(text, label) {
  const match = text.match(new RegExp(`${label} percentile:\\s*(\\d+)ms`));
  return match ? Number(match[1]) : null;
}

export function parseGfxinfo(text) {
  const total = intAfter(text, 'Total frames rendered');
  const janky = text.match(/Janky frames:\s*(\d+)\s*\(([\d.]+)%\)/);
  if (total === null || !janky) throw new Error('not gfxinfo output: no frame totals found');
  return {
    totalFrames: total,
    jankyFrames: Number(janky[1]),
    jankyPct: Number(janky[2]),
    p50Ms: percentileMs(text, '50th'),
    p90Ms: percentileMs(text, '90th'),
    p95Ms: percentileMs(text, '95th'),
    p99Ms: percentileMs(text, '99th'),
    missedVsync: intAfter(text, 'Number Missed Vsync') ?? 0,
    slowUiThread: intAfter(text, 'Number Slow UI thread') ?? 0,
    deadlineMissed: intAfter(text, 'Number Frame deadline missed') ?? 0,
  };
}

export function evaluate(run, thresholds = THRESHOLDS) {
  const inBudgetPct = run.totalFrames === 0 ? 100 : 100 * (1 - run.jankyFrames / run.totalFrames);
  // The two counters overlap heavily; the larger one is the dropped-frame count.
  const droppedFrames = Math.max(run.missedVsync, run.deadlineMissed);
  const failures = [];
  if (inBudgetPct < thresholds.minInBudgetPct) {
    failures.push(`frames in budget ${inBudgetPct.toFixed(1)}% is under ${thresholds.minInBudgetPct}%`);
  }
  if (run.jankyPct > thresholds.maxJankyPct) {
    failures.push(`janky frames ${run.jankyPct}% is over ${thresholds.maxJankyPct}%`);
  }
  if (run.p95Ms !== null && run.p95Ms > thresholds.maxP95Ms) {
    failures.push(`p95 frame time ${run.p95Ms} ms is over ${thresholds.maxP95Ms} ms`);
  }
  if (droppedFrames > thresholds.maxDroppedFrames) {
    failures.push(`${droppedFrames} dropped frames (limit ${thresholds.maxDroppedFrames})`);
  }
  return { inBudgetPct, droppedFrames, pass: failures.length === 0, failures };
}

export function evaluateScenario(runs, thresholds = THRESHOLDS) {
  const results = runs.map((run) => ({ ...run, ...evaluate(run, thresholds) }));
  return { pass: results.every((result) => result.pass), runs: results };
}

export function main(argv = process.argv.slice(2), out = console) {
  const files = [];
  let check = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--file') files.push(argv[(i += 1)]);
    else if (argv[i] === '--check') check = true;
  }
  if (files.length === 0) {
    out.error('usage: node scripts/perf/gfxinfo.mjs --file <gfxinfo.txt> [--file ...] [--check]');
    return 2;
  }
  const runs = files.map((file) => ({ file, ...parseGfxinfo(readFileSync(file, 'utf8')) }));
  const result = evaluateScenario(runs);
  out.log(JSON.stringify(result, null, 2));
  return check && !result.pass ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main());
}
