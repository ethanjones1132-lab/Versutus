import { homeBriefingSummary, type HomeBriefing } from '@/lib/home/briefing';
import type { ActivityRun } from '@/lib/gateway/runs';

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(...parts: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

const card = () => readSource('src', 'components', 'home-briefing-card.tsx');
const dashboard = () => readSource('src', 'components', 'gateway', 'gateway-home-dashboard.tsx');

function run(
  id: string,
  status: ActivityRun['status'],
  finishedAt?: number,
): ActivityRun {
  return { id, prompt: 'do the thing', status, startedAt: 0, finishedAt, events: [] };
}

function briefing(overrides: Partial<HomeBriefing> = {}): HomeBriefing {
  return {
    finished: { complete: [], failed: [], unresolved: [] },
    live: [],
    pendingApprovals: 0,
    ...overrides,
  };
}

describe('homeBriefingSummary', () => {
  test('is empty when the briefing carries no news', () => {
    const summary = homeBriefingSummary(briefing());
    expect(summary.isEmpty).toBe(true);
    expect(summary.lines).toEqual([]);
  });

  test('names finished runs by their own fate, never collapsed into one number', () => {
    const summary = homeBriefingSummary(
      briefing({
        finished: {
          complete: [run('a', 'complete', 1)],
          failed: [run('b', 'failed', 2)],
          unresolved: [run('c', 'unresolved', 3)],
        },
      }),
    );
    expect(summary.finishedCount).toBe(3);
    expect(summary.isEmpty).toBe(false);
    expect(summary.lines).toEqual([
      '1 run failed',
      '1 run ended without a result',
      '1 run finished',
    ]);
  });

  test('surfaces the approvals waiting on the operator', () => {
    const summary = homeBriefingSummary(
      briefing({ live: [run('s', 'waiting-approval')], pendingApprovals: 1 }),
    );
    expect(summary.lines).toEqual(['1 run waiting on your approval']);
    expect(summary.isEmpty).toBe(false);
  });

  test('counts a waiting-approval run once — approval line, not also a still-going line', () => {
    const summary = homeBriefingSummary(
      briefing({
        live: [run('r', 'running'), run('s', 'waiting-approval')],
        pendingApprovals: 1,
      }),
    );
    expect(summary.lines).toEqual([
      '1 run waiting on your approval',
      '1 run still going',
    ]);
  });

  test('pluralizes honestly', () => {
    const summary = homeBriefingSummary(
      briefing({
        finished: {
          complete: [run('a', 'complete', 1), run('b', 'complete', 2)],
          failed: [],
          unresolved: [],
        },
      }),
    );
    expect(summary.lines).toEqual(['2 runs finished']);
  });
});

describe('HomeBriefingCard', () => {
  test('folds the active gateway stamp with the persisted runs', () => {
    const src = card();
    expect(src).toContain('activeGateway');
    expect(src).toContain('loadLastSeen');
    expect(src).toContain('buildHomeBriefing');
    expect(src).toContain('homeBriefingSummary');
  });

  test('renders nothing without a stamp or without news — never a placeholder', () => {
    const src = card();
    expect(src).toMatch(/if \(!summary \|\| summary\.isEmpty\) return null/);
  });

  test('frames the window honestly and opens Activity on tap', () => {
    const src = card();
    expect(src).toContain('While you were away');
    expect(src).toContain("router.push('/activity')");
  });

  test('is mounted above the gateway list', () => {
    const src = dashboard();
    const cardIdx = src.indexOf('<HomeBriefingCard />');
    const listIdx = src.indexOf('<CompactGatewayList');
    expect(cardIdx).toBeGreaterThan(-1);
    expect(listIdx).toBeGreaterThan(cardIdx);
  });
});
