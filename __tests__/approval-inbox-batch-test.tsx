// "Deny all" / "Approve N read-only" used to be N strictly serial
// `decideApproval` calls, and each one re-read the pending list itself — which
// flipped the read to `loading` and replaced the whole inbox with its own
// skeleton, N times for N rows, with no sign of progress. One refusal also
// aborted the loop, so the rows behind it were never decided. These pin: no
// `loading` during a batch, one re-read at the end, every row attempted, a
// determinate progress line, and the tally of what the Gate refused.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

jest.mock('react-native-reanimated', () => ({
  Easing: {
    bezier: () => (value: number) => value,
    elastic: () => (value: number) => value,
  },
}));

jest.mock('@/components/ui', () => ({
  Button: 'Button',
  ErrorCard: 'ErrorCard',
  Icon: 'Icon',
  Skeleton: 'Skeleton',
  Text: 'Text',
}));

jest.mock('@/components/chat/bot-avatar', () => ({ BotAvatar: 'BotAvatar' }));

jest.mock('react-native-svg', () => ({
  __esModule: true,
  default: 'Svg',
  Defs: 'Defs',
  RadialGradient: 'RadialGradient',
  Rect: 'Rect',
  Stop: 'Stop',
}));

type ApprovalRowShape = Parameters<typeof import('@/lib/gateway/approvals').batchApprovableRows>[0][number];

const mockState = {
  pendingApprovals: [] as ApprovalRowShape[],
  pendingApprovalsState: 'ready' as 'loading' | 'ready' | 'failed',
  pendingApprovalsError: null as string | null,
  approvalBusy: null as string | null,
};

/** Every `pendingApprovalsState` the list was rendered with, in order. */
const mockStatesSeen: string[] = [];
/** The ids `decideApproval` was asked for, in call order. */
const mockDecided: string[] = [];
/** The options each `decideApproval` call carried. */
const mockOptionsSeen: ({ refresh?: boolean } | undefined)[] = [];
/** Rows whose decision the Gate refuses. */
const mockRefused = new Set<string>();
/** Settles one outstanding decision; a refused row rejects its own. */
const mockGates: (() => void)[] = [];
let mockRefreshCalls = 0;
const mockRefreshOptions: ({ silent?: boolean } | undefined)[] = [];

/**
 * The provider seam this test stands in for. A loud read is the only thing
 * that flips the list to `loading`, which is what the inbox paints as a
 * skeleton over every row the operator still has to work through.
 */
async function mockProviderRefresh(options?: { silent?: boolean }): Promise<void> {
  if (!options?.silent) {
    mockState.pendingApprovalsState = 'loading';
    mockStatesSeen.push('loading');
  }
  mockRefreshCalls += 1;
  mockRefreshOptions.push(options);
  mockState.pendingApprovalsState = 'ready';
  mockStatesSeen.push('ready');
}

jest.mock('@/context/gateway-provider', () => ({
  useGateway: () => ({
    pendingApprovals: mockState.pendingApprovals,
    pendingApprovalsState: mockState.pendingApprovalsState,
    pendingApprovalsError: mockState.pendingApprovalsError,
    approvalBusy: mockState.approvalBusy,
    refreshPendingApprovals: async (options?: { silent?: boolean }) => {
      await mockProviderRefresh(options);
    },
    decideApproval: async (
      approvalId: string,
      _decision: 'approve' | 'deny',
      options?: { refresh?: boolean },
    ) => {
      mockDecided.push(approvalId);
      mockOptionsSeen.push(options);
      await new Promise<void>((resolve, reject) => {
        mockGates.push(() => {
          if (mockRefused.has(approvalId)) reject(new Error(`approval "${approvalId}" is gone`));
          else resolve();
        });
      });
    },
  }),
}));

import { createElement, type ElementType } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { ApprovalInbox } from '@/components/activity/approval-inbox';

const BUTTON = 'Button' as ElementType;
const ERROR_CARD = 'ErrorCard' as ElementType;

function stringsIn(node: unknown): string[] {
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(stringsIn);
  if (node && typeof node === 'object' && 'children' in node) {
    return stringsIn((node as { children: unknown }).children);
  }
  return [];
}

function row(approvalId: string): ApprovalRowShape {
  return { approvalId, cls: 'workspace_write', summary: `Overwrite the file? (${approvalId})` };
}

let renderer: ReactTestRenderer | null = null;

async function mount(): Promise<void> {
  await act(async () => {
    renderer = create(createElement(ApprovalInbox));
  });
}

function press(label: string): Promise<void> {
  const button = renderer?.root.findAllByType(BUTTON).find((node) => node.props.label === label);
  expect(button).toBeDefined();
  return act(async () => {
    button?.props.onPress();
  });
}

/** Settle the oldest outstanding decision, letting React commit the step. */
async function settleOne(): Promise<void> {
  const gate = mockGates.shift();
  expect(gate).toBeDefined();
  await act(async () => {
    gate?.();
    await Promise.resolve();
  });
}

beforeEach(() => {
  mockState.pendingApprovals = Array.from({ length: 8 }, (_unused, index) => row(`a${index + 1}`));
  mockState.pendingApprovalsState = 'ready';
  mockState.pendingApprovalsError = null;
  mockState.approvalBusy = null;
  mockStatesSeen.length = 0;
  mockDecided.length = 0;
  mockOptionsSeen.length = 0;
  mockRefused.clear();
  mockGates.length = 0;
  mockRefreshCalls = 0;
  mockRefreshOptions.length = 0;
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
});

describe('a batch decision keeps the list on screen and moves through it', () => {
  it('eight rows are decided against a single re-read, and never enter loading', async () => {
    await mount();

    await press('Deny all');
    for (let index = 0; index < 8; index += 1) await settleOne();

    expect(mockDecided).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8']);
    // One re-read, once, after the last decision — not one per row.
    expect(mockRefreshCalls).toBe(1);
    expect(mockRefreshOptions[0]).toEqual({ silent: true });
    // Every per-row decision skipped its own re-read.
    expect(mockOptionsSeen).toHaveLength(8);
    expect(mockOptionsSeen.every((options) => options?.refresh === false)).toBe(true);
    // The one read the inbox did ask for was silent, so the visible list was
    // never swapped for the loading skeleton at any point in the batch.
    expect(mockStatesSeen).not.toContain('loading');
  });

  it('the progress line says how far the batch has got', async () => {
    await mount();

    await press('Deny all');
    expect(stringsIn(renderer?.toJSON())).toContain('Deciding 0 of 8…');

    await settleOne();
    await settleOne();
    expect(stringsIn(renderer?.toJSON())).toContain('Deciding 2 of 8…');

    await settleOne();
    expect(stringsIn(renderer?.toJSON())).toContain('Deciding 3 of 8…');

    for (let index = 0; index < 5; index += 1) await settleOne();
    expect(stringsIn(renderer?.toJSON())).not.toContain('Deciding 8 of 8…');
  });

  it('a refusal mid-batch still decides the rows behind it and says 7 decided, 1 failed', async () => {
    mockRefused.add('a5');
    await mount();

    await press('Deny all');
    for (let index = 0; index < 8; index += 1) await settleOne();

    expect(mockDecided).toHaveLength(8);
    expect(mockRefreshCalls).toBe(1);

    const cards = renderer?.root.findAllByType(ERROR_CARD).map((node) => ({
      cause: String(node.props.cause),
      affected: String(node.props.affected),
    }));
    expect(cards).toContainEqual({
      cause: 'approval "a5" is gone',
      affected: '7 decided, 1 failed',
    });
  });

  it('two refusals report both counts and name the first one', async () => {
    mockRefused.add('a3');
    mockRefused.add('a6');
    await mount();

    await press('Deny all');
    for (let index = 0; index < 8; index += 1) await settleOne();

    const cards = renderer?.root.findAllByType(ERROR_CARD).map((node) => ({
      cause: String(node.props.cause),
      affected: String(node.props.affected),
    }));
    expect(cards).toContainEqual({
      cause: 'approval "a3" is gone',
      affected: '6 decided, 2 failed',
    });
  });

  it('a clean batch reports no failure', async () => {
    await mount();

    await press('Deny all');
    for (let index = 0; index < 8; index += 1) await settleOne();

    expect(renderer?.root.findAllByType(ERROR_CARD)).toHaveLength(0);
  });
});

describe('a single row decision is still one decision, not a batch', () => {
  it('decides the row it was pressed on without taking the batch path', async () => {
    mockState.pendingApprovals = [row('solo')];
    await mount();

    await press('Deny');
    await settleOne();

    // No `refresh: false`: the row decision owns its own re-read, which the
    // provider makes silent, and the inbox adds no read of its own.
    expect(mockDecided).toEqual(['solo']);
    expect(mockOptionsSeen[0]).toBeUndefined();
    expect(mockRefreshCalls).toBe(0);
    expect(mockStatesSeen).not.toContain('loading');
  });

  it('a refused single decision still names the failure', async () => {
    mockRefused.add('solo');
    mockState.pendingApprovals = [row('solo')];
    await mount();

    await press('Approve');
    await settleOne();

    const cards = renderer?.root.findAllByType(ERROR_CARD).map((node) => ({
      cause: String(node.props.cause),
      affected: String(node.props.affected),
    }));
    expect(cards).toContainEqual({
      cause: 'approval "solo" is gone',
      affected: 'This approval decision',
    });
  });
});