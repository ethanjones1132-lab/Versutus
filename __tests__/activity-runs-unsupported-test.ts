// H1: the Activity tab invited "Ask a Bot to do something and it shows up here"
// on a gateway whose `agent` capability is explicitly `unsupported` — a backend
// with no run API, which can never produce a row. The Runs screen already says
// "Runs not offered" for exactly that snapshot. These mount the real
// ActivityScreen (with the real RecentRuns) and pin that the Runs glance says
// the same words, byte-identical to runs.tsx, while a `ready` snapshot and the
// `unknown` one the gateway has not reported yet both keep today's copy. The
// glance figures and the ribbon are untouched: the limitation replaces only the
// empty group, and a gateway that does have runs still lists them.

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

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
  Badge: 'Badge',
  Button: 'Button',
  Card: 'Card',
  EmptyState: 'EmptyState',
  ErrorCard: 'ErrorCard',
  Icon: 'Icon',
  ListRow: 'ListRow',
  PageTitle: 'PageTitle',
  PressableScale: 'PressableScale',
  Screen: 'Screen',
  SectionHeader: 'SectionHeader',
  Skeleton: 'Skeleton',
  Text: 'Text',
  TextField: 'TextField',
}));

jest.mock('@/components/activity/cron-section', () => ({ CronSection: 'CronSection' }));
jest.mock('@/components/activity/cron-job-sheet', () => ({ CronJobSheet: 'CronJobSheet' }));
jest.mock('@/components/activity/cron-run-sheet', () => ({ CronRunSheet: 'CronRunSheet' }));
jest.mock('@/components/nav/drawer-menu-button', () => ({ DrawerMenuButton: 'DrawerMenuButton' }));
jest.mock('@/components/connection-badge', () => ({ PulsingDot: 'PulsingDot' }));
jest.mock('@/components/activity/activity-glance', () => ({ ActivityGlance: 'ActivityGlance' }));
jest.mock('@/components/activity/agent-targets', () => ({ AgentTargets: 'AgentTargets' }));
jest.mock('@/components/activity/approval-decision-card', () => ({ ApprovalDecisionCard: 'ApprovalDecisionCard' }));
jest.mock('@/components/activity/approval-inbox', () => ({ ApprovalInbox: 'ApprovalInbox' }));
// The run row's avatar is a leaf with native imports; only the empty group is
// under test here, and this one row variant has no bot, so it never renders.
jest.mock('@/components/chat/bot-avatar', () => ({ BotAvatar: 'BotAvatar' }));
jest.mock('@/components/gateway/spend-entry-row', () => ({ SpendEntryRow: 'SpendEntryRow' }));

jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return {
    useRouter: () => ({ push: () => undefined }),
    useFocusEffect: (effect: () => void | (() => void)) => {
      useEffect(() => effect(), [effect]);
    },
  };
});

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('@/lib/motion/ambient-parallax', () => ({
  useAmbientParallaxScroll: () => ({ parallaxY: 0, onScroll: () => undefined }),
}));

const alpha: GatewayProfile = {
  id: 'gw-alpha',
  name: 'Alpha',
  url: 'http://alpha.test:8642',
  createdAt: 0,
};

/** A snapshot whose `agent` group is in the given state, as the gateway read it. */
function snapshotWith(agentStatus: GatewayCapabilityGroup['status']): GatewayCapabilitySnapshot {
  return {
    checkedAt: 1_800_000_000_000,
    status: 'fresh',
    groups: [{ id: 'agent', label: 'Agent', status: agentStatus }],
    methods: {},
    scopes: [],
  };
}

const NOW = 1_800_000_000_000;

const mockGateway = {
  activeGateway: alpha as GatewayProfile | null,
  activityRunsForActiveGateway: [] as ActivityRun[],
  capabilitySnapshot: snapshotWith('ready'),
  gateways: [alpha],
  settings: { pcName: 'Alpha' },
  status: 'connected',
  pendingRunApproval: null,
  pendingApprovals: [],
  requestRunFocus: () => undefined,
  resolveRunApproval: () => undefined,
  refreshPendingApprovals: async () => undefined,
  connectGateway: async () => undefined,
  refreshCapabilities: async () => undefined,
  refreshGateways: async () => undefined,
};

jest.mock('@/context/gateway-provider', () => ({ useGateway: () => mockGateway }));

import { createElement, type ElementType } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import ActivityScreen from '@/app/(tabs)/activity';
import type { ActivityRun } from '@/lib/gateway/runs';
import type {
  GatewayCapabilityGroup,
  GatewayCapabilitySnapshot,
  GatewayProfile,
} from '@/lib/gateway/types';

let renderer: ReactTestRenderer | null = null;

async function flush(): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(1);
  });
}

async function mount(): Promise<void> {
  await act(async () => {
    renderer = create(createElement(ActivityScreen));
  });
  await flush();
}

/** Every string the mounted tree renders, in tree order. */
function renderedTexts(): string[] {
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      found.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === 'object' && 'children' in node) {
      walk((node as { children: unknown }).children);
    }
  };
  walk(renderer?.toJSON());
  return found;
}

/**
 * The Runs screen's "Runs not offered" description, read from its source so the
 * Activity copy is compared against the same bytes rather than a transcription.
 */
function runsScreenUnsupportedDescription(gatewayName: string): string {
  const src = nodeFs
    .readFileSync([__dirname, '..', 'src', 'app', 'runs.tsx'].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
  const match = src.match(/`\$\{activeGateway\.name\} is chat-only[^`]*`/);
  expect(match).not.toBeNull();
  const template = match![0];
  return template
    .slice(1, -1)
    .replace('${activeGateway.name}', gatewayName);
}

const NO_RUNS_YET = 'No runs yet. Ask a Bot to do something and it shows up here.';

function run(id: string, status: ActivityRun['status'], agoMs: number): ActivityRun {
  return {
    id,
    prompt: id,
    status,
    startedAt: NOW - agoMs,
    finishedAt: status === 'running' ? undefined : NOW - agoMs + 60_000,
    events: [],
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockGateway.activeGateway = alpha;
  mockGateway.status = 'connected';
  mockGateway.capabilitySnapshot = snapshotWith('ready');
  mockGateway.activityRunsForActiveGateway = [];
});

afterEach(async () => {
  if (renderer) {
    const doomed = renderer;
    renderer = null;
    await act(async () => {
      doomed.unmount();
    });
  }
  jest.clearAllTimers();
  jest.useRealTimers();
});

test('a connected gateway whose agent capability is unsupported is named, not invited', async () => {
  mockGateway.capabilitySnapshot = snapshotWith('unsupported');
  await mount();

  const texts = renderedTexts();
  expect(texts).toContain('Runs not offered');
  // The same sentence Runs shows, byte-for-byte, with this gateway's name.
  expect(texts).toContain(runsScreenUnsupportedDescription(alpha.name));
  // And it never also promises that a run will show up here.
  expect(texts).not.toContain(NO_RUNS_YET);
  expect(texts.join('\n')).not.toContain('Ask a Bot to do something');
});

test('a ready agent capability keeps today\'s "No runs yet" copy exactly', async () => {
  mockGateway.capabilitySnapshot = snapshotWith('ready');
  await mount();

  const texts = renderedTexts();
  expect(texts).toContain(NO_RUNS_YET);
  expect(texts).not.toContain('Runs not offered');
});

test('an agent capability the gateway has not reported keeps today\'s copy', async () => {
  mockGateway.capabilitySnapshot = snapshotWith('unknown');
  await mount();

  const texts = renderedTexts();
  expect(texts).toContain(NO_RUNS_YET);
  expect(texts).not.toContain('Runs not offered');
});

test('an unsupported snapshot while not connected keeps today\'s copy', async () => {
  // The Runs screen only calls the limitation on a live connection; offline,
  // "showing what this phone last saw" must not claim the gateway cannot run.
  mockGateway.status = 'disconnected';
  mockGateway.capabilitySnapshot = snapshotWith('unsupported');
  await mount();

  const texts = renderedTexts();
  expect(texts).toContain(NO_RUNS_YET);
  expect(texts).not.toContain('Runs not offered');
});

test('an unsupported gateway that does have runs still lists them', async () => {
  // The limitation is the empty group's copy, not a replacement for the rows.
  mockGateway.capabilitySnapshot = snapshotWith('unsupported');
  mockGateway.activityRunsForActiveGateway = [run('older-run', 'complete', 60_000)];
  await mount();

  const texts = renderedTexts();
  expect(texts).toContain('older-run');
  expect(texts).not.toContain('Runs not offered');
});

test('the glance and its ribbon keep exactly the inputs they had', async () => {
  mockGateway.capabilitySnapshot = snapshotWith('unsupported');
  mockGateway.activityRunsForActiveGateway = [run('older-run', 'complete', 60_000)];
  await mount();

  const glance = renderer?.root.findByType('ActivityGlance' as ElementType);
  expect(glance).toBeDefined();
  // No capability input added to the glance: its figures and ribbon are
  // untouched, and the limitation is spoken by the Runs group below it.
  expect(Object.keys(glance?.props ?? {}).sort()).toEqual([
    'now',
    'onOpenRun',
    'onOpenRuns',
    'pendingApprovals',
    'runs',
  ]);
  expect(glance?.props.runs).toBe(mockGateway.activityRunsForActiveGateway);
});
