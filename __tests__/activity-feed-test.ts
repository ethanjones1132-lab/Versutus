import { GatewayHttpError } from '@/lib/gateway/errors';
import {
  ActivityFeedParseError,
  EMPTY_ACTIVITY_STATE,
  EMPTY_ROUTINE_FEED_STATE,
  activityCounts,
  applyActivityRead,
  applyRoutineFeedRead,
  coverageNotice,
  parseActivityFeed,
  parseRoutineFeed,
  readFailureKind,
  todaySince,
  type ActivityCoverage,
} from '@/lib/gateway/activity-feed';

const validItem = {
  id: 'run-1',
  backendId: 'backend-1',
  kind: 'run',
  startedAt: '2026-11-10T10:00:00.000Z',
  status: 'complete',
  title: 'Build',
};

describe('activity feed parsing and folds', () => {
  it('uses the local calendar date for todaySince', () => {
    const local = new Date(2026, 10, 10, 16, 42, 11);
    expect(todaySince(local)).toBe(new Date(2026, 10, 10).toISOString());
  });

  it('omits unknown or invalid metrics but retains a real zero cost', () => {
    const feed = parseActivityFeed({
      since: '2026-11-10T00:00:00.000Z',
      generatedAt: '2026-11-10T12:01:00.000Z',
      items: [{
        ...validItem,
        metrics: {
          turns: 4,
          tools: 0,
          tokens: -1,
          costUsd: 0,
          unknown: 20,
          absent: undefined,
          stringMetric: '7',
          invalidCost: -1,
          nullCost: null,
        },
      }, {
        ...validItem,
        id: 'invalid-metric-types',
        metrics: { turns: undefined, tools: 0, tokens: -1, costUsd: '0' },
      }],
    });
    expect(feed.items[0].metrics).toEqual({ turns: 4, costUsd: 0 });
    expect(feed.items[1].metrics).toEqual({});
  });

  it('drops only malformed activity rows and unrecognised coverage statuses', () => {
    const feed = parseActivityFeed({
      since: '2026-11-10T00:00:00.000Z',
      generatedAt: '2026-11-10T12:01:00.000Z',
      backends: [
        { id: 'ok', label: 'OK', status: 'complete' },
        { id: 'bad', label: 'Bad', status: 'mystery' },
        { id: '', label: 'No id', status: 'complete' },
        { id: 'unlabelled', status: 'complete' },
      ],
      items: [
        validItem,
        { ...validItem, id: '' },
        { ...validItem, id: 'bad-time', startedAt: 'not a date' },
        { ...validItem, id: 'second', kind: 'session' },
      ],
    });
    expect(feed.backends.map((backend) => backend.id)).toEqual(['ok', 'unlabelled']);
    expect(feed.backends[1].label).toBe('unlabelled');
    expect(feed.items.map((item) => item.id)).toEqual(['run-1', 'second']);
  });

  it('rejects a non-object payload with a route-named parse error', () => {
    expect(() => parseActivityFeed({})).toThrow(ActivityFeedParseError);
    expect(() => parseActivityFeed(null)).toThrow('/v1/activity');
    expect(() => parseRoutineFeed(null)).toThrow('/v1/routines');
  });

  it('keeps truncation flags only when true', () => {
    const envelope = { since: '2026-11-10T00:00:00.000Z', generatedAt: '2026-11-10T12:01:00.000Z' };
    expect(parseActivityFeed({ ...envelope, truncated: { window: true, items: false } }).truncated).toEqual({ window: true });
    expect(parseActivityFeed({ ...envelope, truncated: { items: 1 } }).truncated).toBeUndefined();
  });

  it('folds activity reads without losing a last good feed', () => {
    const initialFailure = applyActivityRead(EMPTY_ACTIVITY_STATE, { ok: false, error: 'offline' });
    expect(initialFailure).toMatchObject({ loaded: false, failed: true, error: 'offline' });

    const feed = parseActivityFeed({ since: '2026-11-10T00:00:00.000Z', generatedAt: '2026-11-10T12:00:00.000Z', items: [validItem] });
    const success = applyActivityRead(EMPTY_ACTIVITY_STATE, { ok: true, feed }, 5);
    expect(success).toMatchObject({ feed, loaded: true, failed: false, updatedAt: Date.parse(feed.generatedAt) });
    const laterFailure = applyActivityRead(success, { ok: false, error: 'network' });
    expect(laterFailure).toMatchObject({ feed, loaded: true, failed: true, error: 'network', updatedAt: success.updatedAt });
  });

  it('folds routine reads with the same first-failure and stale-success rules', () => {
    const initialFailure = applyRoutineFeedRead(EMPTY_ROUTINE_FEED_STATE, { ok: false, error: 'offline' });
    expect(initialFailure).toMatchObject({ loaded: false, failed: true, error: 'offline' });

    const feed = parseRoutineFeed({ generatedAt: '2026-11-10T12:00:00.000Z', routines: [] });
    const success = applyRoutineFeedRead(EMPTY_ROUTINE_FEED_STATE, { ok: true, feed }, 5);
    expect(success).toMatchObject({ feed, loaded: true, failed: false, updatedAt: Date.parse(feed.generatedAt) });
    const laterFailure = applyRoutineFeedRead(success, { ok: false, error: 'network' });
    expect(laterFailure).toMatchObject({ feed, loaded: true, failed: true, error: 'network', updatedAt: success.updatedAt });
  });

  it('defaults routine paused to false and drops malformed routines', () => {
    const feed = parseRoutineFeed({
      generatedAt: '2026-11-10T12:01:00.000Z',
      routines: [
        { id: 'routine-1', backendId: 'backend-1', name: 'Morning' },
        { id: 'bad', backendId: 'backend-1', name: '' },
      ],
    });
    expect(feed.routines).toEqual([{ id: 'routine-1', backendId: 'backend-1', name: 'Morning', paused: false }]);
  });

  it('counts activity kinds', () => {
    const items = parseActivityFeed({
      since: '2026-11-10T00:00:00.000Z',
      generatedAt: '2026-11-10T12:01:00.000Z',
      items: [validItem, { ...validItem, id: 'session-1', kind: 'session' }],
    }).items;
    expect(activityCounts(items)).toEqual({ runs: 1, sessions: 1 });
  });

  it('provides coverage notices for each status without surfacing backend errors', () => {
    const notice = (status: ActivityCoverage['status']) => coverageNotice({ id: 'b', label: 'Backend', status, error: 'raw detail' });
    expect(notice('complete')).toBeUndefined();
    expect(notice('partial')).toBe("Some of this backend's activity could not be read");
    expect(notice('unavailable')).toBe("Activity isn't supported by this backend");
    expect(notice('failed')).toBe("This backend's activity could not be read");
  });

  it('classifies activity read failures', () => {
    expect(readFailureKind(new GatewayHttpError('missing route', 404))).toBe('unsupported');
    expect(readFailureKind(new GatewayHttpError('unauthorized', 401))).toBe('unauthorized');
    expect(readFailureKind(new Error('Network request failed'))).toBe('offline');
    expect(readFailureKind(new Error('unexpected'))).toBe('failed');
  });
});
