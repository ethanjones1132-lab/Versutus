import { formatClockTime } from '@/lib/format';
import { runEventPreview, type ActivityRun } from '@/lib/gateway/runs';
import {
  runProgressNotice,
  runProgressNoticeIdentifier,
  type RunProgressNotice,
} from '@/lib/notifications/run-progress';
import { routeForTap } from '@/lib/notifications/tap-route';

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

/** The fold's own source, for the cases that pin what it must NOT carry. */
function foldSource(): string {
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'lib', 'notifications', 'run-progress.ts'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

// A fixed clock: the run started 3:42 before the fold is asked, so the elapsed
// line reads `3:42` — the shape `formatDuration` prints on the run card's own
// live elapsed (format.ts:100-110).
const STARTED_AT = Date.parse('2026-09-10T14:00:00Z');
const NOW = STARTED_AT + 222_000;

function run(overrides: Partial<ActivityRun> = {}): ActivityRun {
  return {
    id: 'run-7',
    prompt: 'Explain the vault layout',
    status: 'running',
    startedAt: STARTED_AT,
    events: [],
    ...overrides,
  };
}

/** The body of an update notice. A retire notice carries no copy at all. */
function bodyOf(notice: RunProgressNotice): string {
  if (notice.verb !== 'update') throw new Error(`expected an update, got ${notice.verb}`);
  return notice.body;
}

/** The copy is small enough to assert in full, one line at a time. */
function linesOf(notice: RunProgressNotice): string[] {
  return bodyOf(notice).split('\n');
}

describe('runProgressNotice (the pure run-progress fold)', () => {
  test('the identifier is one string per run, byte-identical across every update', () => {
    // §7's own mechanism: re-posting the same identifier UPDATES the notice the
    // operator already has instead of stacking a second one, so nothing the
    // clock moves may reach it.
    const first = runProgressNotice(run(), NOW);
    const second = runProgressNotice(run({ status: 'waiting-approval' }), NOW + 60_000);
    const third = runProgressNotice(run({ events: [previewedStep('reading the config')] }), NOW + 600_000);
    expect(first.identifier).toBe(runProgressNoticeIdentifier('run-7'));
    expect(second.identifier).toBe(first.identifier);
    expect(third.identifier).toBe(first.identifier);
  });

  test('two runs never share an identifier', () => {
    expect(runProgressNotice(run({ id: 'run-8' }), NOW).identifier).not.toBe(
      runProgressNotice(run({ id: 'run-7' }), NOW).identifier,
    );
  });

  test('the body carries the elapsed watch and the newest step, and only the newest', () => {
    const older = previewedStep('opening the vault');
    const newest = previewedStep('reading widget-device.ts');
    const notice = runProgressNotice(run({ events: [older, newest] }), NOW);
    expect(linesOf(notice)).toEqual(['Elapsed 3:42', newest.preview, `Last update ${formatClockTime(NOW)}`]);
    expect(bodyOf(notice)).not.toContain(older.preview);
  });

  test('the step line is runEventPreview output, passed through untouched', () => {
    // The row stores what the driver already folded with that helper
    // (gateway-provider.tsx:2230); re-wording it here would be this fold
    // authoring a step the run never reported.
    const step = previewedStep('  reading\n  the widget  ');
    expect(step.preview).toBe('reading the widget');
    expect(linesOf(runProgressNotice(run({ events: [step] }), NOW))[1]).toBe(step.preview);
  });

  test('a run with no event yet still gets an honest body, and invents no step', () => {
    expect(linesOf(runProgressNotice(run(), NOW))).toEqual([
      'Elapsed 3:42',
      `Last update ${formatClockTime(NOW)}`,
    ]);
  });

  test('an in-flight run answers update — and the title names what it is stopped on', () => {
    const moving = runProgressNotice(run(), NOW);
    const stopped = runProgressNotice(run({ status: 'waiting-approval' }), NOW);
    expect(moving.verb).toBe('update');
    expect(stopped.verb).toBe('update');
    expect(moving.verb === 'update' && moving.title).toBe('Run in progress');
    expect(stopped.verb === 'update' && stopped.title).toBe('Run needs approval');
  });

  test('a settled run answers retire, and a retire carries no copy', () => {
    // All four endings, `unresolved` included: a run the gateway never judged is
    // over, so an ongoing notice for it would be the lie §7 forbids.
    for (const status of ['complete', 'failed', 'cancelled', 'unresolved'] as const) {
      const notice = runProgressNotice(run({ status }), NOW);
      expect(notice).toEqual({
        verb: 'retire',
        identifier: runProgressNoticeIdentifier('run-7'),
        data: { kind: 'run', runId: 'run-7' },
      });
    }
  });

  test('the payload is the route the tap router already reads', () => {
    // A progress notice that names no run is one `routeForTap` refuses
    // (tap-route.ts:50-54), so the fold carries the payload rather than leaving
    // the poster to rebuild `notifyRunComplete`'s shape.
    expect(routeForTap(runProgressNotice(run(), NOW).data)).toEqual({ kind: 'run', runId: 'run-7' });
  });

  test('the staleness line is the clock this notice was folded at', () => {
    // §7's Constraints: a killed app freezes the notice, so the copy says WHEN
    // it was written. An absolute clock, never a relative "2m ago" — that would
    // be composed once and then read as fresh forever.
    const later = NOW + 3_600_000;
    expect(bodyOf(runProgressNotice(run(), NOW))).toContain(`Last update ${formatClockTime(NOW)}`);
    expect(bodyOf(runProgressNotice(run(), later))).toContain(`Last update ${formatClockTime(later)}`);
    expect(bodyOf(runProgressNotice(run(), NOW))).not.toContain(`Last update ${formatClockTime(later)}`);
  });

  test('a startedAt this client cannot read as a span is not printed as an elapsed watch', () => {
    // The same refusal `watchedRunSpanMs` makes (scorecard.ts:236-241): a
    // non-finite instant, or one this client would have to read as the future,
    // is no watch length at all — and `formatDuration` would answer it `0:00`.
    for (const startedAt of [NaN, Infinity, NOW + 60_000]) {
      const lines = linesOf(runProgressNotice(run({ startedAt }), NOW));
      expect(lines).toEqual([`Last update ${formatClockTime(NOW)}`]);
    }
  });

  test('the fold posts nothing and authors no step', () => {
    // Nothing here schedules, dismisses or channels anything: the poster and the
    // low-importance Android channel are the next slice's work (BACKLOG.md:460).
    const src = foldSource();
    expect(src).not.toContain("from 'expo-notifications'");
    expect(src).not.toContain('scheduleNotificationAsync');
    expect(src).not.toContain('dismissNotification');
    expect(src).not.toContain('setNotificationChannelAsync');
  });

  test('the step is never re-derived: no candidate list and no JSON fallback', () => {
    // `runEventPreview` cannot be called on a stored row — an ActivityRun carries
    // no raw `RunEvent.data`, so the helper would answer its own '{}' fallback
    // (runs.ts:91). The preview comes from the row, untouched and un-invented.
    const src = foldSource();
    expect(src).not.toContain('runEventPreview(');
    expect(src).not.toContain('deltaText');
    expect(src).not.toContain('JSON.stringify');
  });
});

/** A stored row event, folded the way the driver folds one (provider.tsx:2230). */
function previewedStep(text: string): ActivityRun['events'][number] {
  return {
    type: 'message.delta',
    preview: runEventPreview({ type: 'message.delta', data: { deltaText: text } }),
    timestamp: STARTED_AT,
  };
}
