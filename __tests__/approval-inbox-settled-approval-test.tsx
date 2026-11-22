// VS-172. A decision the Gate refuses because the approval is no longer waiting
// (settled on another device, the run ended, the Gate's own timeout) answered
// `404 unknown_approval` with `Unknown approval "<id>"`, and the inbox pasted
// that sentence into the card: to the operator it reads as a bug in their own
// tap, and the dead row stayed in the list to be tapped again. These pin: the
// code-bearing rejection and the sentence-only fallback both get plain language,
// the row is re-read out of the list, every other refusal keeps the Gate's own
// message and no extra read, a success still clears the notice, and the batch
// tally is untouched.

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
  pendingApprovalsState: 'ready' as 'loading' | 'ready' | 'failed' | 'unavailable',
  pendingApprovalsError: null as string | null,
  approvalBusy: null as string | null,
};

/** The ids the card decided, in order. */
const mockDecided: string[] = [];
/**
 * What each decision does once it settles, indexed by the same order as
 * `mockDecided`: `undefined` resolves, anything else rejects with it.
 */
const mockOutcomes: unknown[] = [];
/** Settles one outstanding decision, in call order. */
const mockGates: (() => void)[] = [];
/** What the Gate holds after the next re-read; `null` leaves the list alone. */
let mockRowsAfterRefresh: ApprovalRowShape[] | null = null;
let mockRefreshCalls = 0;
const mockRefreshOptions: ({ silent?: boolean } | undefined)[] = [];

/** The provider seam: a re-read lands the rows the Gate currently holds. */
async function mockProviderRefresh(options?: { silent?: boolean }): Promise<void> {
  mockRefreshCalls += 1;
  mockRefreshOptions.push(options);
  if (!options?.silent) mockState.pendingApprovalsState = 'loading';
  if (mockRowsAfterRefresh) mockState.pendingApprovals = mockRowsAfterRefresh;
  mockState.pendingApprovalsState = 'ready';
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
    decideApproval: async (approvalId: string) => {
      mockDecided.push(approvalId);
      const outcome = mockOutcomes[mockDecided.length - 1];
      await new Promise<void>((resolve, reject) => {
        mockGates.push(() => (outcome === undefined ? resolve() : reject(outcome)));
      });
    },
  }),
}));

import { createElement, type ElementType } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { ApprovalInbox } from '@/components/activity/approval-inbox';
import { GatewayRpcError } from '@/lib/gateway/rpc-scope';

const BUTTON = 'Button' as ElementType;
const ERROR_CARD = 'ErrorCard' as ElementType;

/** The copy the settled row must read as, verbatim. */
const SETTLED_NOTICE = 'This request is no longer waiting — the Gate already settled it or it expired.';
/** The Gate's raw sentence, which must never reach the card on this path. */
const RAW_UNKNOWN = 'Unknown approval "abc"';

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

/** Render again from the provider state the mock now reports. */
async function rerender(): Promise<void> {
  await act(async () => {
    renderer?.update(createElement(ApprovalInbox));
  });
}

async function press(label: string): Promise<void> {
  const button = renderer?.root.findAllByType(BUTTON).find((node) => node.props.label === label);
  expect(button).toBeDefined();
  await act(async () => {
    button?.props.onPress();
  });
}

/**
 * Settle the oldest outstanding decision and let everything it started land:
 * the notice, the tally, and — for a settled row — the inbox's own re-read.
 */
async function settleOne(): Promise<void> {
  const gate = mockGates.shift();
  expect(gate).toBeDefined();
  await act(async () => {
    gate?.();
    // Drain the continuation chain the decision started: the catch, the
    // progress line and, for a settled row, the re-read it awaits.
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
  });
  // The refresh mutates the provider seam without a React store, so the card
  // and the tally are only on screen after this tree renders again.
  await rerender();
}

function errorCards(): { cause: string; affected: string; next: string | undefined }[] {
  return (renderer?.root.findAllByType(ERROR_CARD) ?? []).map((node) => ({
    cause: String(node.props.cause),
    affected: String(node.props.affected),
    next: node.props.next === undefined ? undefined : String(node.props.next),
  }));
}

beforeEach(() => {
  mockState.pendingApprovals = [row('abc')];
  mockState.pendingApprovalsState = 'ready';
  mockState.pendingApprovalsError = null;
  mockState.approvalBusy = null;
  mockOutcomes.length = 0;
  mockDecided.length = 0;
  mockGates.length = 0;
  mockRowsAfterRefresh = null;
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

describe('a decision the Gate has already settled', () => {
  it('names the outcome in plain language when the rejection carries unknown_approval', async () => {
    mockOutcomes[0] = new GatewayRpcError(RAW_UNKNOWN, 'unknown_approval');
    await mount();

    await press('Approve');
    await settleOne();

    const cards = errorCards();
    expect(cards).toHaveLength(1);
    expect(cards[0]?.cause).toBe(SETTLED_NOTICE);
    // The Gate's id-bearing sentence is not what the operator's card says.
    expect(cards.some((card) => card.cause.includes(RAW_UNKNOWN))).toBe(false);
    expect(stringsIn(renderer?.toJSON())).not.toContain(RAW_UNKNOWN);
    // And it is not told to press again: there is nothing left to decide.
    expect(cards[0]?.next).toBe('Nothing to decide: the Gate has already moved on.');
  });

  it('still names it plainly when the rejection lost its code', async () => {
    // A transport that dropped the body's code still leaves this exact line.
    mockOutcomes[0] = new Error(RAW_UNKNOWN);
    await mount();

    await press('Deny');
    await settleOne();

    expect(errorCards()[0]?.cause).toBe(SETTLED_NOTICE);
  });

  it('the sentence fallback is anchored, so a longer message is not claimed', async () => {
    const message = `Session not found: ${RAW_UNKNOWN}`;
    mockOutcomes[0] = new Error(message);
    await mount();

    await press('Approve');
    await settleOne();

    expect(errorCards()[0]?.cause).toBe(message);
  });

  it('re-reads the inbox once and the stale row leaves the list', async () => {
    mockState.pendingApprovals = [row('abc'), row('later')];
    mockRowsAfterRefresh = [row('later')];
    mockOutcomes[0] = new GatewayRpcError(RAW_UNKNOWN, 'unknown_approval');
    await mount();

    await press('Approve');
    await settleOne();
    await rerender();

    // One read, silent: the row leaves without the inbox flashing its skeleton.
    expect(mockRefreshCalls).toBe(1);
    expect(mockRefreshOptions).toEqual([{ silent: true }]);

    const texts = stringsIn(renderer?.toJSON());
    expect(texts).not.toContain('Overwrite the file? (abc)');
    expect(texts).toContain('Overwrite the file? (later)');
    // The row that settled is gone; the one still waiting is still decidable.
    const approveButtons = (renderer?.root.findAllByType(BUTTON) ?? []).filter(
      (node) => node.props.label === 'Approve',
    );
    expect(approveButtons).toHaveLength(1);
  });

  it('a rejection with any other message keeps that message, unchanged', async () => {
    const message = 'A paired device grant is required';
    mockOutcomes[0] = new GatewayRpcError(message, 'pairing_required');
    await mount();

    await press('Approve');
    await settleOne();

    const cards = errorCards();
    expect(cards).toHaveLength(1);
    expect(cards[0]?.cause).toBe(message);
    expect(cards[0]?.next).toBe('Try the decision again.');
    // A refusal about the decision says nothing about what the Gate holds, so
    // the inbox does not spend a read on it.
    expect(mockRefreshCalls).toBe(0);
  });

  it('does not rewrite a refusal whose own code is something else', async () => {
    // The code decides the outcome, not the words: only a rejection with no
    // code at all may fall back to matching the Gate's sentence.
    mockOutcomes[0] = new GatewayRpcError(RAW_UNKNOWN, 'approval_owner_mismatch');
    await mount();

    await press('Approve');
    await settleOne();

    expect(errorCards()[0]?.cause).toBe(RAW_UNKNOWN);
  });

  it('a successful decision still clears the notice', async () => {
    mockState.pendingApprovals = [row('abc'), row('later')];
    mockRowsAfterRefresh = [row('later')];
    mockOutcomes[0] = new GatewayRpcError(RAW_UNKNOWN, 'unknown_approval');
    await mount();

    await press('Approve');
    await settleOne();
    expect(errorCards()).toHaveLength(1);
    // The re-read that dropped the dead row has landed; render from it.
    await rerender();

    mockOutcomes[1] = undefined;
    await press('Approve');
    await settleOne();

    expect(mockDecided).toEqual(['abc', 'later']);
    expect(errorCards()).toHaveLength(0);
    // The provider owns the post-success re-read; the inbox adds none.
    expect(mockRefreshCalls).toBe(1);
  });
});

describe('a batch that meets an already-settled row', () => {
  it('names it plainly and still counts it as failed', async () => {
    mockState.pendingApprovals = [row('abc'), row('later')];
    mockOutcomes[0] = new GatewayRpcError(RAW_UNKNOWN, 'unknown_approval');
    mockOutcomes[1] = undefined;
    await mount();

    await press('Deny all');
    await settleOne();
    await settleOne();
    await rerender();

    // The tally is exactly what it was: one decided, one the Gate refused.
    const cards = errorCards();
    expect(cards).toHaveLength(1);
    expect(cards[0]?.cause).toBe(SETTLED_NOTICE);
    expect(cards[0]?.affected).toBe('1 decided, 1 failed');
    // Still the batch's single closing re-read, not one per row.
    expect(mockRefreshCalls).toBe(1);
  });
});
