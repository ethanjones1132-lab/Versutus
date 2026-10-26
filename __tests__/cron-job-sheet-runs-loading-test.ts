declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSheetSource(): string {
  // Normalize line endings so the block regexes below do not depend on the
  // file's line endings.
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'components', 'activity', 'cron-job-sheet.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

describe('cron job sheet runs loading', () => {
  test('the pre-first-read branch holds layout with two Skeleton rows', () => {
    // The first run-history read is deferred a tick, and the sheet claimed
    // "No runs recorded yet." in that window, then popped to rows when the
    // read landed. The sheet now renders skeletons like the sibling Cron
    // surfaces, so the layout holds instead of flashing an empty claim.
    const src = readSheetSource();
    expect(src).toContain('Skeleton');
    const loading = src.match(/\{\!runsError && \!runsLoaded \? \([\s\S]*?\) : null\}/)?.[0];
    expect(loading).toBeDefined();
    expect(loading).toMatch(/<Skeleton width="90%" height=\{44\}/);
    expect(loading).toMatch(/<Skeleton width="76%" height=\{44\}/);
  });

  test('the no-runs line renders only after a successful empty read', () => {
    // Once a read has landed (runsLoaded set) with zero runs, the sheet
    // must say the routine recorded nothing — the skeletons belong to the
    // pre-first-read window only.
    const src = readSheetSource();
    const empty = src.match(
      /\{\!runsError && runsLoaded && runs\.length === 0 \? \([\s\S]*?\) : null\}/,
    )?.[0];
    expect(empty).toBeDefined();
    expect(empty).toContain('No runs recorded yet.');
  });

  test('the first read marks loaded on success and on refusal', () => {
    // A refused read must reach the runsError caption + Retry path, never
    // the skeletons: both loadRuns outcomes flip the flag.
    const src = readSheetSource();
    const loader = src.match(/const loadRuns = useCallback\(async \(\) => \{[\s\S]*?\}, \[cron, jobId\]\);/)?.[0];
    expect(loader).toBeDefined();
    expect(loader).toMatch(/setRunsLoaded\(true\)/);
    expect(loader?.match(/setRunsLoaded\(true\)/g)).toHaveLength(2);
  });

  test('the runsError caption and Retry path are untouched', () => {
    // The skeletons change only what the sheet shows while it waits; a
    // refused read still names the failure with a retry beside it.
    const src = readSheetSource();
    const blocks = src.match(/\{runsError \? \([\s\S]*?\) : null\}/g);
    expect(blocks).toBeDefined();
    expect(src).toMatch(/variant="caption" color="statusDisconnected"/);
    const retry = (blocks ?? []).find((block) => block.includes('label="Retry"'));
    expect(retry).toBeDefined();
    expect(retry).toMatch(/onPress=\{\(\) => void loadRuns\(\)\}/);
  });
});

// The sheet renders one row per run record. `CronRun.error` is declared on the
// wire type, but the subtitle only ever read `status`, so a scheduled run that
// failed read as a success with its turn count and nothing else.

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));

jest.mock('react-native-reanimated', () => ({
  Easing: {
    bezier: () => (value: number) => value,
    elastic: () => (value: number) => value,
  },
}));

jest.mock('@/components/ui', () => ({
  BaseSheet: 'BaseSheet',
  Button: 'Button',
  ConfirmSheet: 'ConfirmSheet',
  Divider: 'Divider',
  ListRow: 'ListRow',
  Skeleton: 'Skeleton',
  Text: 'Text',
}));

jest.mock('@/lib/haptics', () => ({ haptics: { success: jest.fn(async () => undefined) } }));

const mockRuns = jest.fn(async () => [] as unknown[]);
const mockBotJobs = {
  run: jest.fn(async () => undefined),
  pause: jest.fn(async () => undefined),
  remove: jest.fn(async () => undefined),
};
const mockCron = { available: true, runs: mockRuns };

jest.mock('@/context/gateway-provider', () => ({
  useGateway: () => ({ botJobs: mockBotJobs, cron: mockCron }),
}));

jest.mock('@/lib/notifications/routine-sync', () => ({
  syncRoutineNotification: jest.fn(async () => undefined),
  cancelRoutineNotification: jest.fn(async () => undefined),
}));

import { createElement, type ElementType } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { CronJobSheet } from '@/components/activity/cron-job-sheet';
import type { CronJob, CronRun } from '@/lib/gateway/cron';

const LIST_ROW = 'ListRow' as ElementType;

function run(partial: Partial<CronRun> & Pick<CronRun, 'id' | 'turnCount'>): CronRun {
  return { jobId: 'job-1', status: 'completed', ...partial };
}

const sheetJob: CronJob = { id: 'job-1', title: 'Nightly' };

describe('a run row names the failure the host reported', () => {
  let renderer: ReactTestRenderer | null = null;

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(async () => {
    if (renderer) {
      const doomed = renderer;
      renderer = null;
      await act(async () => {
        doomed.unmount();
      });
    }
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  test('an errored run reads failed on one line, and a clean run keeps completed and its turns', async () => {
    mockRuns.mockResolvedValueOnce([
      run({
        id: 'bad',
        turnCount: 3,
        error: 'model "scout" is not configured\nRetry at the next schedule.',
      }),
      run({ id: 'good', turnCount: 4, startedAt: 1000, finishedAt: 4000 }),
      run({ id: 'live', turnCount: 0, status: 'running' }),
      run({ id: 'long', turnCount: 1, error: 'x'.repeat(200) }),
    ]);

    await act(async () => {
      renderer = create(
        createElement(CronJobSheet, {
          job: sheetJob,
          onClose: () => undefined,
          onOpenRun: () => undefined,
        }),
      );
    });
    // The first run-history read is deferred one tick, like the sheet's own.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1);
    });

    const subtitles = (renderer?.root.findAllByType(LIST_ROW) ?? []).map((node) =>
      String(node.props.subtitle),
    );
    expect(subtitles).toHaveLength(4);
    // A failed run says so, carries the host's message, and stays one line.
    expect(subtitles[0]).toContain('failed');
    expect(subtitles[0]).toContain('model "scout" is not configured Retry at the next schedule.');
    expect(subtitles[0]).not.toContain('\n');
    // A clean run still reads completed with its turn count and elapsed time.
    expect(subtitles[1]).toContain('completed');
    expect(subtitles[1]).toContain('3s');
    expect(subtitles[1]).toContain('4 turns');
    // An in-flight run is still running, never completed.
    expect(subtitles[2]).toContain('running');
    // A very long host error is bounded rather than dumped into the row.
    expect(subtitles[3]).toContain('failed');
    expect(subtitles[3].endsWith('…')).toBe(true);
    expect(subtitles[3].length).toBeLessThan(140);
  });
});
