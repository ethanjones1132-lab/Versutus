/**
 * VS-171 — a notification response that survives a restart dispatches its
 * ACTION, not just its destination.
 *
 * The tap that launches the process is not replayed to the response listener
 * (Expo v57 notifications docs), so it reaches the app only as
 * `getLastNotificationResponse()`. Before this, the launch path read that
 * response for its payload and navigated, dropping the `actionIdentifier` — an
 * Approve / Deny taken from the tray opened the run still waiting instead of
 * settling the approval promise the in-app sheet resolves.
 *
 * These tests mount the real NotificationRouter, with the native module holding
 * the cold-start response and the gateway reporting the pending approval, so
 * the resolver and the acknowledgement are observed through the launch path
 * itself — not only through the pure helper.
 */

import type { ConnectionStatus } from '@/lib/gateway/types';

const mockRouter = { navigate: jest.fn(), push: jest.fn(), replace: jest.fn(), back: jest.fn() };
const mockNative: { last: import('expo-notifications').NotificationResponse | null } = { last: null };
const mockNotifyDecided = jest.fn();
const mockNotifyRefused = jest.fn();

const mockGateway = {
  isBootstrapped: true,
  gateways: [] as { id: string }[],
  activeGateway: null as { id: string } | null,
  connectGateway: jest.fn(),
  pendingRunApproval: null as { runId: string; prompt: string } | null,
  resolveRunApproval: jest.fn(),
  status: 'connected' as ConnectionStatus,
  openBot: jest.fn(async () => true),
  sendChatInput: jest.fn(async () => 'sent'),
  requestSurface: jest.fn(),
  requestRunFocus: jest.fn(),
  gatewayRequest: jest.fn(),
};

jest.mock('@/global.css', () => ({}));

jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('expo-notifications', () => ({
  getLastNotificationResponse: jest.fn(() => mockNative.last),
  clearLastNotificationResponse: jest.fn(() => {
    mockNative.last = null;
  }),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  setNotificationCategoryAsync: jest.fn(async () => null),
  SchedulableTriggerInputTypes: { DAILY: 'daily', WEEKLY: 'weekly', DATE: 'date', TIME_INTERVAL: 'timeInterval' },
  DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
}));
jest.mock('expo-linking', () => ({
  __esModule: true,
  useURL: () => null,
  parse: jest.fn(),
}));
jest.mock('expo-router/head', () => ({ __esModule: true, default: () => null }));
jest.mock('expo-router', () => ({
  Stack: Object.assign(() => null, { Screen: () => null }),
  ThemeProvider: ({ children }: { children?: unknown }) => children,
  useRouter: () => mockRouter,
}));
jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));
jest.mock('expo-navigation-bar', () => ({ NavigationBar: () => null }));

jest.mock('@/components/animated-icon', () => ({ AnimatedSplashOverlay: () => null }));
jest.mock('@/components/app-bootstrap', () => ({ AppBootstrap: ({ children }: { children?: unknown }) => children }));
jest.mock('@/components/app-lock-gate', () => ({ AppLockGate: ({ children }: { children?: unknown }) => children }));
jest.mock('@/components/connected-toast', () => ({ ConnectedToast: () => null }));
jest.mock('@/components/error-fallback', () => ({ ErrorFallback: () => null }));
jest.mock('@/components/font-provider', () => ({ FontProvider: ({ children }: { children?: unknown }) => children }));
jest.mock('@/components/voice/handsfree-call-banner', () => ({ HandsfreeCallBanner: () => null }));
jest.mock('@/components/gateway/tls-fingerprint-guard', () => ({ TlsFingerprintGuard: () => null }));
jest.mock('@/components/layout/stage-signal-bridge', () => ({ StageSignalBridge: () => null }));

jest.mock('@/constants/navigation-theme', () => ({
  VersutusDarkTheme: { colors: { background: '#000', card: '#111', text: '#fff' } },
}));

jest.mock('@/context/gateway-provider', () => ({
  GatewayProvider: ({ children }: { children?: unknown }) => children,
  useGateway: () => mockGateway,
}));
jest.mock('@/context/demo-gateway-provider', () => ({ DemoGatewayProvider: () => null }));
jest.mock('@/context/handsfree-voice-provider', () => ({
  HandsfreeVoiceProvider: ({ children }: { children?: unknown }) => children,
}));

jest.mock('@/lib/demo/showcase-mode', () => ({ isShowcaseMode: () => false }));
jest.mock('@/lib/diagnostics/failure-log', () => ({
  installGlobalFailureHandlers: jest.fn(),
  recordFailure: jest.fn(),
}));
jest.mock('@/lib/gateway/deep-link', () => ({ deepLinkTarget: jest.fn() }));
jest.mock('@/lib/gateway/session-open-by-id', () => ({
  openSessionById: jest.fn(),
  openSessionByIdFailureText: jest.fn(() => ''),
}));
jest.mock('@/lib/gateway/share-intent', () => ({
  dismissSharedText: jest.fn(),
  listenForSharedText: jest.fn(async () => () => undefined),
  sharedTextRequest: jest.fn(),
}));
jest.mock('@/lib/net/streaming-fetch', () => ({ installStreamingFetch: jest.fn() }));
jest.mock('@/lib/voice/voice-engine-choice', () => ({ supportsHandsfreeCalls: () => false }));
jest.mock('@/lib/notifications/local', () => ({
  ensurePushChannels: jest.fn(),
  installForegroundNotificationHandler: jest.fn(),
  notifyApprovalDecided: (...args: unknown[]) => mockNotifyDecided(...args),
  notifyApprovalRefused: (...args: unknown[]) => mockNotifyRefused(...args),
  notifyBotReplyNotSent: jest.fn(),
  notifySessionOpenFailed: jest.fn(),
}));

import * as Notifications from 'expo-notifications';
import TestRenderer, { act } from 'react-test-renderer';

import { NotificationRouter } from '@/app/_layout';
import {
  APPROVAL_APPROVE_ACTION_ID,
  APPROVAL_DENY_ACTION_ID,
  APPROVAL_NOTICE_DATA_KIND,
} from '@/lib/notifications/categories';

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

function between(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  if (start === -1) return '';
  const rest = src.slice(start + startMarker.length);
  const end = rest.indexOf(endMarker);
  return end === -1 ? rest : rest.slice(0, end);
}

/** The cold-start response expo keeps for the tap that launched the process. */
function approvalResponse(
  actionIdentifier: string,
  runId: string,
): Notifications.NotificationResponse {
  return {
    notification: {
      date: 0,
      request: {
        identifier: 'approval-notice',
        content: {
          title: 'Approval needed',
          subtitle: null,
          body: 'A run is waiting on your decision.',
          categoryIdentifier: 'approval',
          sound: 'default',
          data: { kind: APPROVAL_NOTICE_DATA_KIND, runId, gatewayKey: 'gw-a' },
        },
        trigger: null,
      },
    },
    actionIdentifier,
  };
}

let renderer: ReturnType<typeof TestRenderer.create> | undefined;

/** Mount the real router with the native module holding one launch response. */
function mountRouter(): void {
  act(() => {
    renderer = TestRenderer.create(<NotificationRouter />);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockNative.last = null;
  mockGateway.isBootstrapped = true;
  mockGateway.pendingRunApproval = { runId: 'run-7', prompt: 'Allow this write?' };
  mockGateway.resolveRunApproval = jest.fn();
  mockGateway.status = 'connected';
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('the launch tap dispatches an approval ACTION', () => {
  test('a cold-start Approve resolves the pending approval with true and posts the acknowledgement', () => {
    mockNative.last = approvalResponse(APPROVAL_APPROVE_ACTION_ID, 'run-7');

    mountRouter();

    // The same resolver the in-app approval sheet calls (chat-screen's
    // onApprove), reached from the response that launched the process.
    expect(mockGateway.resolveRunApproval).toHaveBeenCalledTimes(1);
    expect(mockGateway.resolveRunApproval).toHaveBeenCalledWith(true);
    expect(mockNotifyDecided).toHaveBeenCalledWith('approve');
    expect(mockNotifyRefused).not.toHaveBeenCalled();
    // A landed decision leaves the tap path: the run it settled is not also
    // opened as if nothing had been decided.
    expect(mockRouter.navigate).not.toHaveBeenCalled();
  });

  test('a cold-start Deny resolves it with false and posts the denial', () => {
    mockNative.last = approvalResponse(APPROVAL_DENY_ACTION_ID, 'run-7');

    mountRouter();

    expect(mockGateway.resolveRunApproval).toHaveBeenCalledTimes(1);
    expect(mockGateway.resolveRunApproval).toHaveBeenCalledWith(false);
    expect(mockNotifyDecided).toHaveBeenCalledWith('deny');
    expect(mockNotifyRefused).not.toHaveBeenCalled();
    expect(mockRouter.navigate).not.toHaveBeenCalled();
  });
});

describe('a launch tap that is not a decision keeps its ordinary route', () => {
  test('tapping the notice body decides nothing', () => {
    mockNative.last = approvalResponse(Notifications.DEFAULT_ACTION_IDENTIFIER, 'run-7');

    mountRouter();

    expect(mockGateway.resolveRunApproval).not.toHaveBeenCalled();
    expect(mockNotifyDecided).not.toHaveBeenCalled();
    expect(mockNotifyRefused).not.toHaveBeenCalled();
    // The approval payload still routes to Runs, where the run is waiting.
    expect(mockRouter.navigate).toHaveBeenCalledWith('/runs');
  });
});

describe('a launch action that cannot be applied is refused, never silently dropped', () => {
  test('an action naming another run is refused and the pending approval is kept', () => {
    mockNative.last = approvalResponse(APPROVAL_APPROVE_ACTION_ID, 'run-8');

    mountRouter();

    expect(mockGateway.resolveRunApproval).not.toHaveBeenCalled();
    expect(mockNotifyDecided).not.toHaveBeenCalled();
    expect(mockNotifyRefused).toHaveBeenCalledWith('no-longer-waiting');
    // Kept pending for the operator to decide in the app.
    expect(mockGateway.pendingRunApproval).toEqual({
      runId: 'run-7',
      prompt: 'Allow this write?',
    });
    // The refusal is not a decision, so the run it named is still opened.
    expect(mockRouter.navigate).toHaveBeenCalledWith('/runs');
  });

  test('an action taken while the connection is gone is refused as unreachable', () => {
    mockGateway.status = 'disconnected';
    mockNative.last = approvalResponse(APPROVAL_APPROVE_ACTION_ID, 'run-7');

    mountRouter();

    expect(mockGateway.resolveRunApproval).not.toHaveBeenCalled();
    expect(mockNotifyDecided).not.toHaveBeenCalled();
    expect(mockNotifyRefused).toHaveBeenCalledWith('unreachable');
    expect(mockGateway.pendingRunApproval).toEqual({
      runId: 'run-7',
      prompt: 'Allow this write?',
    });
  });
});

describe('the router wires the launch response to the dispatcher', () => {
  test('the launch block passes the pending approval and live status to applyLaunchApproval', () => {
    const launchBlock = between(
      readSource('src', 'app', '_layout.tsx'),
      'const launch = readLaunchResponse();',
      'if (isBootstrapped && pendingTapRef.current)',
    );

    // The launch path is where the response that survived the restart is
    // handled; without this call the action is read but never applied, which is
    // exactly the dropped decision these tests exist to prevent.
    expect(launchBlock).toContain('applyLaunchApproval(launch, {');
    expect(launchBlock).toContain('pending: approvalRef.current');
    expect(launchBlock).toContain('status: statusRef.current');
    expect(launchBlock).toContain('notifyDecided: notifyApprovalDecided');
    expect(launchBlock).toContain('notifyRefused: notifyApprovalRefused');
    // A landed decision leaves the tap path; a body tap or a refusal still
    // holds the destination it named.
    expect(launchBlock).toContain("if (launchApproval !== 'decided')");
  });
});
