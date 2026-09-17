import { androidWidgetPayload } from '@/lib/widget/android-widget-payload';
import { glanceableSnapshot, type GlanceableSnapshot } from '@/lib/widget/snapshot';

const base: GlanceableSnapshot = {
  status: 'connected',
  runsInFlight: 3,
  approvalsPending: 1,
  lastResult: 'Deployed the fix',
  writtenAt: 1_757_700_000_000,
};

describe('androidWidgetPayload', () => {
  test('carries the same words the iOS widget draws, plus what the native card needs', () => {
    expect(androidWidgetPayload(base)).toEqual({
      v: 3,
      status: 'Connected',
      connected: true,
      work: '1 run waiting on your approval · 2 runs in flight',
      result: 'Deployed the fix',
      approvalsPending: 1,
      writtenAt: 1_757_700_000_000,
    });
  });

  test('carries the routine tallies, and they survive redaction — counts are not names', () => {
    const payload = androidWidgetPayload({
      ...base,
      bots: [{ id: 'a', label: 'A' }],
      redact: true,
      routineAlerts: { late: 1, failing: 2 },
    });
    expect(payload.routinesLate).toBe(1);
    expect(payload.routinesFailing).toBe(2);
  });

  test('a snapshot with no routine tallies leaves them out', () => {
    expect(androidWidgetPayload(base)).not.toHaveProperty('routinesLate');
    expect(androidWidgetPayload(base)).not.toHaveProperty('routinesFailing');
  });

  test('an absent result stays absent', () => {
    const { lastResult: _omit, ...rest } = base;
    expect(androidWidgetPayload(rest)).not.toHaveProperty('result');
  });

  test('a disconnected snapshot is not drawn as connected', () => {
    const payload = androidWidgetPayload({ ...base, status: 'reconnecting' });
    expect(payload.connected).toBe(false);
    expect(payload.status).toBe('Reconnecting');
  });

  test('survives the JSON round trip the native module parses', () => {
    expect(JSON.parse(JSON.stringify(androidWidgetPayload(base)))).toEqual(androidWidgetPayload(base));
  });

  test('carries up to three in-flight runs for the large cell', () => {
    const payload = androidWidgetPayload({
      ...base,
      runs: [
        { title: 'a', state: 'Running' },
        { title: 'b', state: 'Running' },
        { title: 'c', state: 'Running' },
        { title: 'd', state: 'Running' },
      ],
    });
    expect(payload.v).toBe(3);
    expect(payload.runs).toEqual([
      { title: 'a', state: 'Running' },
      { title: 'b', state: 'Running' },
      { title: 'c', state: 'Running' },
    ]);
  });

  test('a snapshot with no in-flight runs omits them', () => {
    expect(androidWidgetPayload(base)).not.toHaveProperty('runs');
  });

  test('carries up to three Bots for the quick-launch rows', () => {
    const bots = [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
      { id: 'c', label: 'C' },
      { id: 'd', label: 'D' },
    ];
    const payload = androidWidgetPayload({ ...base, bots });
    expect(payload.bots).toEqual(bots.slice(0, 3));
  });

  test('carries the full Roster separately from the three quick-launch rows', () => {
    const bots = Array.from({ length: 12 }, (_, index) => ({ id: `bot-${index}`, label: `Bot ${index}` }));
    const snapshot = glanceableSnapshot({ status: 'connected', runs: [], routines: [], bots }, base.writtenAt);
    const payload = androidWidgetPayload(snapshot);
    expect(payload.bots).toEqual(bots.slice(0, 3));
    expect(payload.configBots).toEqual(bots);
    expect(JSON.parse(JSON.stringify(payload)).configBots).toEqual(bots);
    expect(androidWidgetPayload({ ...snapshot, redact: true })).not.toHaveProperty('configBots');
  });

  test('an empty Roster stays empty even when recent runs name removed Bots', () => {
    const snapshot = glanceableSnapshot({ status: 'connected', runs: [], routines: [], bots: [] }, base.writtenAt);
    expect(androidWidgetPayload({ ...snapshot, bots: [{ id: 'removed', label: 'Removed' }] }).configBots).toEqual([]);
    expect(androidWidgetPayload(base)).not.toHaveProperty('configBots');
  });

  test('configuration trims and deduplicates the Roster without inventing run-only Bots', () => {
    const snapshot = glanceableSnapshot({
      status: 'connected', runs: [], routines: [],
      bots: [{ id: ' a ', label: ' A ' }, { id: 'a', label: 'A' }, { id: 'b' }, { id: ' ' }],
    }, base.writtenAt);
    expect(androidWidgetPayload(snapshot).configBots).toEqual([{ id: 'a', label: 'A' }, { id: 'b', label: 'b' }]);
  });

  test('a snapshot with no Bots omits them', () => {
    expect(androidWidgetPayload(base)).not.toHaveProperty('bots');
  });

  test('redaction drops the result and the Bot rows, and keeps the counts and stamp', () => {
    const payload = androidWidgetPayload({
      ...base,
      bots: [{ id: 'a', label: 'A' }],
      redact: true,
    });
    expect(payload.redact).toBe(true);
    expect(payload).not.toHaveProperty('result');
    expect(payload).not.toHaveProperty('bots');
    expect(payload.work).toBe('1 run waiting on your approval · 2 runs in flight');
    expect(payload.writtenAt).toBe(base.writtenAt);
  });
});
