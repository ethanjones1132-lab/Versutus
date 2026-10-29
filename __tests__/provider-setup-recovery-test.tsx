/**
 * VS-035 — a connected gateway is not a promise that chat can run.
 *
 * Terra's first-run walk connected a throwaway Gate with no provider
 * credential, read "Ready for chat" on Home, then had chat answer
 * `provider has no credential to send` with no useful next step. Both halves
 * are pinned here against the mounted dashboard and the real humanizer: the
 * dashboard may say only what the connection proves, and the Gate's
 * `missing_credentials` refusal must reach the provider-setup route instead of
 * being read as a rejected gateway token or a network fault.
 *
 * No provider data is fetched or invented. The only readiness the dashboard
 * can see is the manifest's `providers[]`, which may be a cached copy with no
 * timestamp — and the capability counts tally slash commands when no provider
 * is declared — so it cannot prove chat readiness. The tests therefore pin
 * "unknown" wording and the setup route, never a positive ready claim.
 */
import { createElement, type ElementType, type ReactElement } from 'react';

// tokens.ts reads Easing for Motion curves; reanimated's native worklet
// unpackers cannot load under jest-expo.
jest.mock('react-native-reanimated', () => ({
  Easing: {
    bezier: () => (value: number) => value,
    elastic: () => (value: number) => value,
  },
}));

const mockLinkHrefs: string[] = [];
const mockRouterPush = jest.fn();

// Link is the setup route's only carrier on Home. Keep the rendered tree (and
// its `asChild` child) intact, and record every destination it was asked for.
jest.mock('expo-router', () => {
  const react = require('react') as typeof import('react');
  function MockLink({
    href,
    asChild,
    children,
  }: {
    href: unknown;
    asChild?: boolean;
    children: ReactElement;
  }) {
    const target = String(href);
    mockLinkHrefs.push(target);
    // expo-router's Link asChild hands the child its own press handler; model
    // that here so the test can press the real button and see the destination.
    const child = children as ReactElement<{ onPress?: () => void }>;
    return asChild
      ? react.cloneElement(child, { onPress: () => mockRouterPush(target) })
      : react.createElement('Link', { href }, children);
  }
  return {
    useRouter: () => ({ push: mockRouterPush, replace: jest.fn(), back: jest.fn() }),
    Link: MockLink,
  };
});

// The kit primitives are host components, so their props are the dashboard's
// real output: a Button keeps `label`, a Text keeps its string.
jest.mock('@/components/ui', () => ({
  Badge: 'Badge',
  Button: 'Button',
  Card: 'Card',
  ConfirmSheet: 'ConfirmSheet',
  ErrorCard: 'ErrorCard',
  Icon: 'Icon',
  PressableScale: 'PressableScale',
  SectionHeader: 'SectionHeader',
  Text: 'Text',
}));

// Siblings of the hero card are inert here: none of them is the surface this
// test is pinning, and standing them in keeps their host/native reads out.
jest.mock('@/components/connection-badge', () => ({
  ConnectionBadge: 'ConnectionBadge',
  PulsingDot: 'PulsingDot',
  statusColor: () => '#000000',
}));
jest.mock('@/components/discovered-gateway-row', () => ({
  DiscoveredGatewayRow: 'DiscoveredGatewayRow',
}));
jest.mock('@/components/glass-collapsible', () => ({ GlassCollapsible: 'GlassCollapsible' }));
jest.mock('@/components/home-briefing-card', () => ({ HomeBriefingCard: 'HomeBriefingCard' }));
jest.mock('@/components/home-status-card', () => ({ HomeStatusCard: 'HomeStatusCard' }));
jest.mock('@/components/pairing-panel', () => ({ PairingPanel: 'PairingPanel' }));
jest.mock('@/components/gateway/capability-hive', () => ({ CapabilityHive: 'CapabilityHive' }));
jest.mock('@/components/gateway/channel-status-row', () => ({ ChannelStatusRow: 'ChannelStatusRow' }));
jest.mock('@/components/gateway/compact-gateway-list', () => ({
  CompactGatewayList: 'CompactGatewayList',
}));
jest.mock('@/components/gateway/gateway-capabilities', () => ({
  GatewayCapabilities: 'GatewayCapabilities',
}));
jest.mock('@/components/gateway/health-checks-pane', () => ({
  HealthChecksPane: 'HealthChecksPane',
}));
jest.mock('@/components/gateway/paired-devices-pane', () => ({
  PairedDevicesPane: 'PairedDevicesPane',
}));

// Native side effects, not the units under test.
jest.mock('@/lib/haptics', () => ({
  haptics: { light: jest.fn(async () => undefined), success: jest.fn(async () => undefined) },
}));
jest.mock('@/hooks/use-gateway-discovery', () => ({
  useGatewayDiscovery: () => ({
    status: 'idle',
    gateways: [],
    nativeAvailable: false,
    rescan: jest.fn(),
    stop: jest.fn(),
  }),
}));
jest.mock('@/hooks/use-gateway-reachability', () => ({
  useGatewayReachability: () => ({}),
}));

// The provider is the data seam, exactly as it is on the device: the test
// chooses the connection and the capability snapshot the dashboard reads.
const mockGatewayState: Record<string, unknown> = {};
jest.mock('@/context/gateway-provider', () => ({
  useGateway: () => mockGatewayState,
}));

import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { GatewayHomeDashboard } from '@/components/gateway/gateway-home-dashboard';
import { GatewayHttpError } from '@/lib/gateway/errors';
import {
  describeGatewayError,
  errorBannerButton,
  humanizeGatewayError,
} from '@/lib/gateway/error-humanizer';

const BUTTON = 'Button' as ElementType;
const BADGE = 'Badge' as ElementType;
const TEXT = 'Text' as ElementType;

const PROFILE = {
  id: 'gw-1',
  name: 'Home PC',
  url: 'http://gate.test',
  kind: 'hermes',
};

const SETUP_ROUTE = '/gateway/setup';

function emptySnapshot(
  groups: { id: string; label: string; status: string; availableCount?: number; totalCount?: number }[] = [],
): Record<string, unknown> {
  return {
    checkedAt: 1,
    status: 'warming',
    groups,
    methods: {},
    scopes: [],
  };
}

function resetGateway(patch: Record<string, unknown> = {}): void {
  Object.assign(mockGatewayState, {
    gateways: [PROFILE],
    activeGateway: PROFILE,
    activeHello: { server: { version: '1.0.0' } },
    status: 'connected',
    statusDetail: undefined,
    lastError: null,
    connectionPhase: 'connected',
    probeMessage: undefined,
    deviceId: 'device-1',
    pairingDetails: undefined,
    settings: { pcName: 'Home PC', tailscaleHost: 'pc.tailnet.ts.net' },
    capabilitySnapshot: emptySnapshot(),
    activityRuns: [],
    pendingRunApproval: null,
    autoRetry: undefined,
    connectGateway: jest.fn(async () => undefined),
    addGateway: jest.fn(async () => PROFILE),
    deleteGateway: jest.fn(async () => undefined),
    retryAutoConnect: jest.fn(async () => undefined),
    refreshCapabilities: jest.fn(async () => undefined),
    ...patch,
  });
}

function stringsIn(node: unknown): string[] {
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(stringsIn);
  if (node && typeof node === 'object' && 'children' in node) {
    return stringsIn((node as { children: unknown }).children);
  }
  return [];
}

let renderer: ReactTestRenderer | undefined;

async function mountDashboard(): Promise<ReactTestRenderer> {
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = create(createElement(GatewayHomeDashboard));
  });
  expect(tree).toBeDefined();
  renderer = tree;
  return tree as ReactTestRenderer;
}

function renderedText(tree: ReactTestRenderer): string {
  const fromTextNodes = tree.root
    .findAllByType(TEXT)
    .flatMap((node) => stringsIn(node.props.children))
    .join(' ');
  return `${stringsIn(tree.toJSON()).join(' ')} ${fromTextNodes}`;
}

function buttonLabels(tree: ReactTestRenderer): string[] {
  return tree.root.findAllByType(BUTTON).map((node) => String(node.props.label));
}

function badgeLabels(tree: ReactTestRenderer): string[] {
  return tree.root.findAllByType(BADGE).map((node) => String(node.props.label));
}

beforeEach(() => {
  mockLinkHrefs.length = 0;
  mockRouterPush.mockClear();
  resetGateway();
});

afterEach(async () => {
  if (renderer) {
    const doomed = renderer;
    renderer = undefined;
    await act(async () => {
      doomed.unmount();
    });
  }
  jest.clearAllMocks();
});

describe('Home separates gateway connectivity from chat readiness', () => {
  test('a connected gateway with no readiness evidence never promises ready chat', async () => {
    const tree = await mountDashboard();
    const shown = renderedText(tree);

    // The connection itself is stated plainly...
    expect(shown).toContain('Connected to your gateway.');
    // ...and chat readiness is not inferred from it.
    expect(shown).toContain('Chat readiness is unknown');
    expect(shown).not.toMatch(/ready for chat/i);

    // The operator has the route that configures a provider...
    expect(buttonLabels(tree)).toContain('Providers & gateways');
    expect(mockLinkHrefs).toContain(SETUP_ROUTE);
    // ...and pressing it reaches `/gateway/setup`, the route chat's setup
    // action already opens.
    const setupButton = tree.root
      .findAllByType(BUTTON)
      .find((node) => node.props.label === 'Providers & gateways');
    expect(setupButton).toBeDefined();
    await act(async () => {
      setupButton?.props.onPress();
    });
    expect(mockRouterPush).toHaveBeenCalledWith(SETUP_ROUTE);
  });

  test('an unknown or command-tallied provider group still cannot prove chat readiness', async () => {
    // The providers group's counts tally Models slash commands when the Gate
    // declares no provider, and the manifest entry carries no readiness stamp.
    // Both shapes below are therefore not evidence that a model can answer.
    const shapes = [
      emptySnapshot([
        { id: 'providers', label: 'Providers', status: 'unknown' },
      ]),
      emptySnapshot([
        { id: 'providers', label: 'Providers', status: 'ready', availableCount: 3, totalCount: 3 },
      ]),
    ];

    for (const capabilitySnapshot of shapes) {
      resetGateway({ capabilitySnapshot });
      const tree = await mountDashboard();
      const shown = renderedText(tree);

      expect(shown).toContain('Chat readiness is unknown');
      expect(shown).not.toMatch(/ready for chat/i);
      expect(mockLinkHrefs).toContain(SETUP_ROUTE);

      const doomed = tree;
      renderer = undefined;
      await act(async () => {
        doomed.unmount();
      });
    }
  });

  test('a disconnected gateway stays honest and does not offer chat', async () => {
    resetGateway({
      status: 'disconnected',
      connectionPhase: 'failed',
      activeHello: null,
    });

    const tree = await mountDashboard();
    const shown = renderedText(tree);

    expect(badgeLabels(tree)).toContain('Disconnected');
    expect(shown).toContain('Saved locally. Select a reachable gateway to activate it.');
    expect(shown).not.toMatch(/ready for chat/i);
    expect(shown).not.toContain('Chat readiness is unknown');
    // A provider is not the first thing to fix while there is no connection.
    expect(mockLinkHrefs).not.toContain(SETUP_ROUTE);
  });
});

describe('the Gate missing-provider-credential refusal reaches provider setup', () => {
  const MESSAGE = 'provider has no credential to send';

  function expectSetupRecovery(error: unknown): void {
    const humanized = humanizeGatewayError(error);

    // Plainly the provider's state, not this phone's gateway token...
    expect(humanized.title).toBe('Model provider needs configuration');
    expect(humanized.cause).toMatch(/model provider/i);
    // ...with the connection's own verdict kept separate...
    expect(humanized.cause).toMatch(/gateway connection itself succeeded/i);
    expect(humanized.affected).toBe('model provider');
    // ...and the exact next step named.
    expect(humanized.next).toMatch(/Settings > Providers & gateways/);
    expect(humanized.action).toBe('setup');

    // The action the chat banner maps to `/gateway/setup`.
    expect(errorBannerButton(humanized.action)).toEqual({
      kind: 'setup',
      label: 'Open gateway setup',
    });
    expect(describeGatewayError(error)).toContain('Settings > Providers & gateways');
  }

  test('classifies the message when the transport retained only text', () => {
    expectSetupRecovery(new Error(MESSAGE));
  });

  test('classifies the typed code even when the transport kept no body message', () => {
    expectSetupRecovery(new GatewayHttpError('credential required', 409, 'missing_credentials'));
  });

  test('classifies a code carried on a plain Error, as chat streams can retain it', () => {
    const error = new Error(MESSAGE) as Error & { code?: string };
    error.code = 'missing_credentials';
    expectSetupRecovery(error);
  });

  test('does not let a 401/409 read as this phone’s gateway key or a network fault', () => {
    for (const status of [401, 403, 409, 502]) {
      const humanized = humanizeGatewayError(new GatewayHttpError(MESSAGE, status));
      expect(humanized.title).toBe('Model provider needs configuration');
      expect(humanized.title).not.toBe('Gateway rejected the key');
      expect(humanized.action).toBe('setup');
    }
  });

  test('keeps every pre-existing classification', () => {
    const abort = new Error('The operation was aborted.');
    abort.name = 'AbortError';
    expect(humanizeGatewayError(abort)).toMatchObject({ title: 'Cancelled', action: 'dismiss' });

    expect(humanizeGatewayError(new GatewayHttpError('invalid api key', 401))).toMatchObject({
      title: 'Gateway rejected the key',
      action: 'setup',
    });
    expect(humanizeGatewayError(new Error('setup token required'))).toMatchObject({
      title: 'Setup token required',
      action: 'setup',
    });
    expect(humanizeGatewayError(new GatewayHttpError('chat failed: 401', 401))).toMatchObject({
      title: 'Model provider refused the request',
      action: 'dismiss',
    });
    expect(humanizeGatewayError(new Error('Network request failed'))).toMatchObject({
      title: 'Could not reach the gateway',
      action: 'reconnect',
    });
  });
});
