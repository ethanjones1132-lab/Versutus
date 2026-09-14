import * as cron from '@/lib/gateway/cron';
import {
  cronListSummaryText,
  describeCronHealth,
  type CronJob,
} from '@/lib/gateway/cron';
import { readFileSync } from 'node:fs';

const job = (over: Partial<CronJob> = {}, id = 'j'): CronJob => ({ id, title: 'Job', ...over });

test('the summary names every non-ok bucket beside the running badge', () => {
  const jobs = [
    job({ id: 'broken-1', failureStreak: 2 }),
    job({ id: 'broken-2', lastStatus: 'timeout' }),
    job({ id: 'cool', lastStatus: 'ok', cooldownReason: 'rate limited' }),
    job({ id: 'paused-1', paused: true }),
    job({ id: 'paused-2', paused: true }),
    job({ id: 'paused-3', paused: true, pausedReason: 'manual' }),
    job({ id: 'new-1' }),
    job({ id: 'new-2' }),
    job({ id: 'fine', lastStatus: 'ok' }),
  ];
  // lastStatus 'timeout' is not 'error' (no streak) — it is warned.
  expect(cronListSummaryText(jobs)).toBe('1 failing · 1 cooling down · 1 warned · 3 paused · 2 unreported');
});

test('a clean list reads nothing — the header stays as it is', () => {
  expect(cronListSummaryText([job({ lastStatus: 'ok' }), job({ lastStatus: 'ok', running: true })])).toBeNull();
  expect(cronListSummaryText([])).toBeNull();
});

test('the verdict is describeCronHealth\'s — a paused job with a streak is off on purpose, not failing', () => {
  expect(cronListSummaryText([job({ paused: true, failureStreak: 2 })])).toBe('1 paused');
});

test('a ran-but-undelivered job is named for what failed, not dressed as cooling down', () => {
  expect(cronListSummaryText([job({ lastStatus: 'ok', lastDeliveryError: 'discord 503' })])).toBe(
    '1 delivery failed',
  );
});

test('a warn verdict the fold cannot subname reads as warned, never healthy', () => {
  // lastStatus present but not 'ok', no streak, no delivery error.
  expect(cronListSummaryText([job({ lastStatus: 'partial' })])).toBe('1 warned');
});

test('the buckets stay in one frozen order whatever the input order', () => {
  const text = cronListSummaryText([
    job({ id: 'unknown' }),
    job({ id: 'paused', paused: true }),
    job({ id: 'failing', failureStreak: 1 }),
  ]);
  expect(text).toBe('1 failing · 1 paused · 1 unreported');
});

test('the section renders the fold and the header row is unchanged when it is null', () => {
  const src = readFileSync('src/components/activity/cron-section.tsx', 'utf8');
  expect(src).toContain('cronListSummaryText');
  // The running badge stays byte-identical, and the summary renders nothing when clean.
  expect(src).toContain('runningCount(jobs)');
  expect(src).toContain('`${live} running`');
});
