// Coverage ratchet: a one-way door for src/lib/gateway coverage.
//
// The static floor in package.json (jest.coverageThreshold) stops a collapse,
// but it rots: it permits a slow slide from 42% down to the pinned 38%, and
// nobody ever raises it. This compares against the last recorded high-water
// mark instead -- fail on any drop, and record the new mark when it improves.
//
// Run: npx tsx scripts/coverage-ratchet.mts   (after a --coverage jest run)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const summaryPath = join(root, 'coverage', 'coverage-summary.json');
const baselinePath = join(root, 'coverage-baseline.json');

type Metric = 'statements' | 'branches' | 'functions' | 'lines';
const METRICS: Metric[] = ['statements', 'branches', 'functions', 'lines'];

/**
 * Slack, in percentage points, before a drop is treated as a regression.
 * Coverage moves fractionally when unrelated files are added, and a ratchet
 * that fails on 0.01pp of noise gets disabled rather than fixed.
 */
const TOLERANCE = 0.5;

if (!existsSync(summaryPath)) {
  console.error(
    `coverage-ratchet: ${summaryPath} not found.\n` +
      'Run a coverage build first (npm run test:coverage); the json-summary\n' +
      'reporter must be enabled in package.json jest.coverageReporters.',
  );
  process.exit(1);
}

const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as {
  total: Record<Metric, { pct: number }>;
};

const current = Object.fromEntries(
  METRICS.map((metric) => [metric, Number(summary.total[metric].pct.toFixed(2))]),
) as Record<Metric, number>;

if (!existsSync(baselinePath)) {
  writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
  console.log('coverage-ratchet: no baseline yet — recorded the current run as the high-water mark:');
  console.log(`  ${METRICS.map((m) => `${m} ${current[m]}%`).join(', ')}`);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Record<Metric, number>;

const regressions: string[] = [];
const improvements: string[] = [];
const next: Record<Metric, number> = { ...baseline };

for (const metric of METRICS) {
  const was = baseline[metric] ?? 0;
  const now = current[metric];

  if (now < was - TOLERANCE) {
    regressions.push(`${metric}: ${now}% is below the ${was}% high-water mark`);
  } else if (now > was) {
    improvements.push(`${metric}: ${was}% → ${now}%`);
    next[metric] = now;
  }
}

for (const metric of METRICS) {
  const marker = current[metric] >= (baseline[metric] ?? 0) ? 'ok  ' : 'DROP';
  console.log(`  ${marker}  ${metric.padEnd(11)} ${current[metric]}%  (mark ${baseline[metric] ?? 0}%)`);
}

if (regressions.length > 0) {
  console.error('\ncoverage-ratchet: coverage regressed');
  for (const line of regressions) console.error(`  - ${line}`);
  console.error(
    '\nAdd tests for what you changed, or — if the drop is intentional — lower\n' +
      'coverage-baseline.json in the same commit so the decision is reviewable.',
  );
  process.exit(1);
}

if (improvements.length > 0) {
  writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  console.log('\ncoverage-ratchet: new high-water mark recorded');
  for (const line of improvements) console.log(`  + ${line}`);
  console.log('Commit coverage-baseline.json alongside your change.');
} else {
  console.log('\ncoverage-ratchet: holding at the current mark');
}
