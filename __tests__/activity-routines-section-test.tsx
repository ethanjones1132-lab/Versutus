import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { RoutinesSection } from '@/components/activity/routines-section';
import type { RoutineFeed } from '@/lib/gateway/activity-feed';
import { GatewayHttpError } from '@/lib/gateway/errors';

// tokens.ts imports Easing from reanimated, whose native worklets cannot load
// under Jest; the curves are never evaluated here.
jest.mock('react-native-reanimated', () => ({
  Easing: {
    bezier: () => (value: number) => value,
    elastic: () => (value: number) => value,
  },
}));

jest.mock('@/components/ui', () => ({
  Button: 'Button',
  Card: 'Card',
  Chip: 'Chip',
  ErrorCard: 'ErrorCard',
  ListRow: 'ListRow',
  SectionHeader: 'SectionHeader',
  Skeleton: 'Skeleton',
  Text: 'Text',
}));
jest.mock('@/components/activity/cron-job-sheet', () => ({ CronJobSheet: 'CronJobSheet' }));
jest.mock('@/components/activity/cron-run-sheet', () => ({ CronRunSheet: 'CronRunSheet' }));

const mockGateway = {
  activeGateway: { id: 'gw-a', name: 'Alpha', url: 'http://alpha.test:8642' } as
    | { id: string; name: string; url: string }
    | undefined,
  status: 'connected',
  activityFeed: {
    readActivity: jest.fn(),
    readRoutines: jest.fn(),
  },
};

jest.mock('@/context/gateway-provider', () => ({ useGateway: () => mockGateway }));

function feed(routines: RoutineFeed['routines'], backends: RoutineFeed['backends']): RoutineFeed {
  return { generatedAt: '2026-11-10T12:00:00.000Z', backends, routines };
}

function deferredFeed(): { promise: Promise<RoutineFeed>; resolve: (value: RoutineFeed) => void } {
  let resolve!: (value: RoutineFeed) => void;
  const promise = new Promise<RoutineFeed>((settle) => { resolve = settle; });
  return { promise, resolve };
}

let renderer: ReactTestRenderer | null = null;

function mount(): void {
  act(() => {
    renderer = create(<RoutinesSection reloadSignal={0} />);
  });
}

async function flush(ms = 1): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

function rowTitles(): string[] {
  if (!renderer) return [];
  return renderer.root
    .findAllByType('ListRow' as never)
    .map((node) => (node.props as { title: string }).title);
}

function rowSubtitles(): string[] {
  if (!renderer) return [];
  return renderer.root
    .findAllByType('ListRow' as never)
    .map((node) => (node.props as { subtitle?: string }).subtitle ?? '');
}

function textContent(): string[] {
  if (!renderer) return [];
  return renderer.root.findAllByType('Text' as never).flatMap((node) => {
    const value = (node.props as { children?: unknown }).children;
    return typeof value === 'string' ? [value] : [];
  });
}

function buttonLabels(): string[] {
  if (!renderer) return [];
  return renderer.root
    .findAllByType('Button' as never)
    .map((node) => (node.props as { label?: string }).label ?? '');
}

function errorCards(): number {
  if (!renderer) return 0;
  return renderer.root.findAllByType('ErrorCard' as never).length;
}

beforeEach(() => {
  jest.useFakeTimers();
  mockGateway.activeGateway = { id: 'gw-a', name: 'Alpha', url: 'http://alpha.test:8642' };
  mockGateway.status = 'connected';
  mockGateway.activityFeed.readRoutines.mockReset();
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('the Routines view tells each backend apart', () => {
  test('a mixed feed shows the rows, a neutral unsupported line and a named failure with Retry', async () => {
    mockGateway.activityFeed.readRoutines.mockResolvedValue(feed(
      [
        { id: 'job-1', backendId: 'hermes', botId: 'mira', name: 'Nightly digest', paused: false, schedule: '0 3 * * *' },
        { id: 'job-2', backendId: 'hermes', name: 'Gateway sweep', paused: true },
      ],
      [
        { id: 'hermes', label: 'Hermes', status: 'complete' },
        { id: 'opencode', label: 'OpenCode', status: 'unavailable' },
        { id: 'hermes-b', label: 'Hermes 2', status: 'failed', error: 'Backend routine read timed out' },
      ],
    ));

    mount();
    await flush();

    expect(rowTitles()).toEqual(['Nightly digest', 'Gateway sweep']);
    const texts = textContent();
    // A backend with no routine concept is a quiet fact, not a failure.
    expect(texts).toContain('OpenCode: not supported here');
    // The failed host carries the Gate's reason, and only it offers Retry.
    expect(texts).toContain('Hermes 2: Backend routine read timed out');
    expect(buttonLabels()).toContain('Retry');
    expect(texts.some((text) => /OpenCode: (failed|could not)/.test(text))).toBe(false);
    // Only the per-host line is red; the whole read did not fail.
    expect(errorCards()).toBe(0);
    expect(texts).toContain('Hermes: 2 routines');
  });

  test('Bots that are not set up read as a neutral count, and statuses as words', async () => {
    const soon = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    mockGateway.activityFeed.readRoutines.mockResolvedValue(feed(
      [
        { id: 'job-1', backendId: 'hermes', name: 'Nightly digest', paused: false, lastStatus: 'ok', nextRunAt: soon },
        { id: 'job-2', backendId: 'hermes', name: 'Inbox sweep', paused: false, lastStatus: 'blocked_config' },
      ],
      [
        {
          id: 'hermes',
          label: 'Hermes',
          status: 'partial',
          error: 'Bot anvil could not be read; Bot bounty could not be read; Bot closer could not be read',
        },
      ],
    ));

    mount();
    await flush();

    // The wire's words are translated for the row.
    expect(rowSubtitles()).toEqual(['Last run OK · next in 3 h', 'Needs setup']);
    // Setup trouble is a neutral count, not the Gate's semicolon-joined list.
    const texts = textContent();
    expect(texts).toContain("Hermes: 2 routines · 3 Bots aren't set up yet");
    expect(texts.join('\n')).not.toContain('could not be read;');
    expect(texts.join('\n')).not.toContain('blocked_config');
    expect(errorCards()).toBe(0);
    expect(buttonLabels()).not.toContain('Retry');
  });

  test('an older Gate without the route says so without a failure card', async () => {
    mockGateway.activityFeed.readRoutines.mockRejectedValue(new GatewayHttpError('Not Found', 404));

    mount();
    await flush();

    expect(textContent()).toContain('This gateway does not report routines.');
    expect(errorCards()).toBe(0);
  });
});

describe('the routine feed belongs to the Gate on screen', () => {
  test('a Gate switch clears the previous Gate rows and starts its own read', async () => {
    const fromA = deferredFeed();
    mockGateway.activityFeed.readRoutines
      .mockReturnValueOnce(fromA.promise)
      .mockResolvedValueOnce(feed(
        [{ id: 'b-1', backendId: 'hermes-b', name: 'B digest', paused: false }],
        [{ id: 'hermes-b', label: 'Hermes B', status: 'complete' }],
      ));

    mount();
    await flush();
    expect(mockGateway.activityFeed.readRoutines).toHaveBeenCalledTimes(1);

    mockGateway.activeGateway = { id: 'gw-b', name: 'Beta', url: 'http://beta.test:8642' };
    act(() => {
      renderer!.update(<RoutinesSection reloadSignal={0} />);
    });
    await flush();
    // The B read is a new request, not the A one still open, and A's rows
    // were cleared with the Gate that owned them.
    expect(mockGateway.activityFeed.readRoutines).toHaveBeenCalledTimes(2);
    expect(rowTitles()).toEqual(['B digest']);

    // A late answer from the Gate we left paints nothing under the new one.
    act(() => {
      fromA.resolve(feed(
        [{ id: 'a-1', backendId: 'hermes-a', name: 'A digest', paused: false }],
        [{ id: 'hermes-a', label: 'Hermes A', status: 'complete' }],
      ));
    });
    await flush();
    expect(rowTitles()).toEqual(['B digest']);
  });
});
