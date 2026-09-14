import { nextRunLabel } from '@/lib/gateway/cron';

const now = Date.parse('2026-08-25T06:00:00Z');

test('a job seconds from its fire reads due, never "in 0m"', () => {
  // 20 s rounds to 0 minutes; a job the gateway is about to fire cannot say
  // "in 0m" — the due branch owns the sub-minute read.
  expect(nextRunLabel('2026-08-25T06:00:20Z', now)).toBe('due');
  // 59 s rounds up to 1 already — the defect is only the sub-30-second tail.
  expect(nextRunLabel('2026-08-25T06:00:59Z', now)).toBe('in 1m');
});

test('a fire past the half-minute still counts its minute', () => {
  // The countdown branch keeps answering for anything that rounds to 1+.
  expect(nextRunLabel('2026-08-25T06:01:00Z', now)).toBe('in 1m');
  expect(nextRunLabel('2026-08-25T06:06:00Z', now)).toBe('in 6m');
});

test('past, far, and unparseable labels are byte-identical', () => {
  // The must-KEEP clause: every other label and the null answer are unchanged.
  expect(nextRunLabel('2026-08-25T05:59:00Z', now)).toBe('due');
  expect(nextRunLabel('2026-08-25T09:00:00Z', now)).toBe('in 3h');
  // 9 h round up over 12 h? No: Math.round(180/60) = 3 — still the hours read.
  expect(nextRunLabel('2026-08-25T14:59:00Z', now)).toBe('in 9h');
  expect(nextRunLabel('not-a-date', now)).toBeNull();
});
