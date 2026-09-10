import {
  LAUNCH_REPLAY_WINDOW_MS,
  isLaunchReplay,
  readLaunchResponse,
  type LaunchTap,
} from '@/lib/notifications/launch-response';

// The mock holds the one response the native module is holding, so the
// retire-on-read rule is exercised for real: clearLastNotificationResponse
// empties it exactly as the native emitter does, and the case that a platform
// without the emitter (web) throws is pinned too.
const mockNative = { last: null as unknown as Notifications.NotificationResponse | null };

jest.mock('expo-notifications', () => ({
  getLastNotificationResponse: jest.fn(() => mockNative.last),
  clearLastNotificationResponse: jest.fn(() => {
    mockNative.last = null;
  }),
}));

import * as Notifications from 'expo-notifications';

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

const layout = () => readSource('src', 'app', '_layout.tsx');

function between(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  if (start === -1) return '';
  const rest = src.slice(start + startMarker.length);
  const end = rest.indexOf(endMarker);
  return end === -1 ? rest : rest.slice(0, end);
}

/** The response shape expo hands a tap, with a routine notice's payload. */
function launchResponse(identifier: string): Notifications.NotificationResponse {
  return {
    notification: {
      date: 0,
      request: {
        identifier,
        content: {
          title: 'Morning briefing is due',
          subtitle: null,
          body: 'Open Versutus to see what it finds.',
          categoryIdentifier: null,
          sound: 'default',
          data: { kind: 'routine-due', jobId: 'job-1', botId: 'scout' },
        },
        trigger: null,
      },
    },
    // The mock replaces the module, so the constant is spelled: expo's own
    // DEFAULT_ACTION_IDENTIFIER, the actionIdentifier of a plain tap.
    actionIdentifier: 'expo.modules.notifications.actions.DEFAULT',
  };
}

const mockGet = Notifications.getLastNotificationResponse as jest.Mock;
const mockClear = Notifications.clearLastNotificationResponse as jest.Mock;

describe('readLaunchResponse (the tap that launched the app)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNative.last = null;
  });

  test('returns the launch tap and retires it', () => {
    const response = launchResponse('notif-1');
    mockNative.last = response;

    expect(readLaunchResponse()).toBe(response);
    // Retired at the source: nothing is left for a later effect — or a later
    // process — to route a second time.
    expect(mockClear).toHaveBeenCalledTimes(1);
    expect(readLaunchResponse()).toBeNull();
    // The second read found nothing, so it retired nothing.
    expect(mockClear).toHaveBeenCalledTimes(1);
  });

  test('no launch tap reads null and retires nothing', () => {
    expect(readLaunchResponse()).toBeNull();
    expect(mockClear).not.toHaveBeenCalled();
  });

  test('a platform without the native emitter has no launch tap, never a crash', () => {
    mockGet.mockImplementationOnce(() => {
      throw new Error('UnavailabilityError');
    });
    expect(readLaunchResponse()).toBeNull();
    expect(mockClear).not.toHaveBeenCalled();
  });
});

describe('isLaunchReplay (one tap, one route)', () => {
  const launch: LaunchTap = { identifier: 'notif-1', at: 1_000 };

  test('the launch identifier inside the window is the same tap again', () => {
    expect(isLaunchReplay(launch, 'notif-1', 1_000)).toBe(true);
    expect(isLaunchReplay(launch, 'notif-1', 1_000 + LAUNCH_REPLAY_WINDOW_MS)).toBe(true);
  });

  test('a different notification is never the launch tap', () => {
    expect(isLaunchReplay(launch, 'notif-2', 1_000)).toBe(false);
  });

  test('nothing armed is not a replay', () => {
    expect(isLaunchReplay(null, 'notif-1', 1_000)).toBe(false);
  });

  test('the guard expires, so a repeating routine keeps routing', () => {
    // expo's NotificationRequest doc: many notifications may be triggered with
    // the same request — a repeating notice keeps ONE identifier across fires.
    // Tomorrow's tap on the same routine is a fresh tap, not a replay.
    expect(isLaunchReplay(launch, 'notif-1', 1_000 + LAUNCH_REPLAY_WINDOW_MS + 1)).toBe(false);
  });

  test('a clock that went backwards is not trusted as a replay', () => {
    expect(isLaunchReplay(launch, 'notif-1', 999)).toBe(false);
  });
});

describe('NotificationRouter launch routing', () => {
  test('routes the launch tap through the same decision as a live tap', () => {
    const src = between(layout(), 'function NotificationRouter', 'function GatewayDeepLinkRouter');
    expect(src).toContain('readLaunchResponse');
    expect(src).toContain('routeForTap');
    expect(src).toContain("route?.kind === 'routine'");
    expect(src).toContain("'/chat'");
    expect(src).toContain("'/activity'");
  });

  test('holds the launch tap until bootstrap has mounted the Stack', () => {
    const src = between(layout(), 'function NotificationRouter', 'function GatewayDeepLinkRouter');
    expect(src).toContain('isBootstrapped');
    expect(src).toContain('pendingTapRef');
  });

  test('reads the launch tap once, not on every effect run', () => {
    const src = between(layout(), 'function NotificationRouter', 'function GatewayDeepLinkRouter');
    expect(src).toContain('launchReadRef.current = true');
  });

  test('skips the launch tap when the live listener delivers it again', () => {
    const src = between(layout(), 'function NotificationRouter', 'function GatewayDeepLinkRouter');
    expect(src).toContain('isLaunchReplay(launchTapRef.current, identifier)');
  });

  test('a tap on a running app still routes through the response listener', () => {
    const src = between(layout(), 'function NotificationRouter', 'function GatewayDeepLinkRouter');
    expect(src).toContain('addNotificationResponseReceivedListener');
    expect(src).toContain('response.notification.request.content.data');
  });

  test('a tap that arrives before bootstrap is held, not navigated', () => {
    const src = between(layout(), 'function NotificationRouter', 'function GatewayDeepLinkRouter');
    const listener = between(
      src,
      'addNotificationResponseReceivedListener',
      'return () => subscription.remove()',
    );
    // The listener navigates only behind the bootstrap guard; before the
    // Stack is mounted the destination is held in the same slot the launch
    // tap uses, so the boot overlay's first-run redirect cannot swallow it.
    const hold = listener.indexOf('if (!isBootstrapped)');
    const navigate = listener.indexOf('router.navigate(destination)');
    expect(hold).toBeGreaterThan(-1);
    expect(navigate).toBeGreaterThan(hold);
    expect(listener).toContain('pendingTapRef.current = destination');
  });

  test('a held tap is routed once, when bootstrap completes', () => {
    const src = between(layout(), 'function NotificationRouter', 'function GatewayDeepLinkRouter');
    expect(src).toContain('if (isBootstrapped && pendingTapRef.current)');
  });

  test('the deep-link router keeps its add / gateway/add handling', () => {
    const src = between(layout(), 'function GatewayDeepLinkRouter', 'export default function RootLayout');
    // Both spellings are `deepLinkTarget`'s own cases now (that suite reads
    // `add` and `gateway/add`); the router still hands the link's path and
    // query to the fold and pushes that target's params to the same sheet.
    expect(src).toContain('deepLinkTarget(parsed.path, parsed.queryParams ?? {})');
    expect(src).toContain("pathname: '/gateway/add'");
    expect(src).toContain('params: target.params');
  });
});

describe('a run notice asks for the run the Activity list must show', () => {
  const routerSource = () =>
    between(layout(), 'function NotificationRouter', 'function GatewayDeepLinkRouter');

  test('only a run route becomes a run focus', () => {
    const src = routerSource();

    // The destination drops the id — Activity is one tab, so there is no route
    // to carry it — and the run rides beside it instead. A routine, a weekly
    // report and an unrecognized payload all ask for no focus at all.
    expect(src).toContain("route?.kind === 'run' ? { runId: route.runId } : null");
  });

  test('the tap lands, then the tab is asked to drop a filter that could hide the run', () => {
    const src = routerSource();
    const listener = between(
      src,
      'addNotificationResponseReceivedListener',
      'return () => subscription.remove()',
    );

    const navigate = listener.indexOf('router.navigate(destination)');
    const ask = listener.indexOf('runFocusRef.current?.(runFocus)');
    expect(navigate).toBeGreaterThan(-1);
    expect(ask).toBeGreaterThan(navigate);
    expect(listener).toContain(
      'const runFocus = runFocusFor(response.notification.request.content.data)',
    );
  });

  test('a tap that launched the app keeps its run focus across the bootstrap wait', () => {
    const src = routerSource();

    // Held in the same slot the destination is: a run notice is usually tapped
    // exactly that way, and a focus dropped on the way is the defect back.
    expect(src).toContain(
      'pendingRunFocusRef.current = runFocusFor(launch.notification.request.content.data)',
    );
    expect(src).toContain('const runFocus = pendingRunFocusRef.current');
    expect(src).toContain('pendingRunFocusRef.current = null');
  });

  test('the request is mirrored into a ref, so the listener is still registered once', () => {
    const src = routerSource();

    expect(src).toContain('runFocusRef.current = requestRunFocus');
    const listenerEnd = src.slice(src.indexOf('addNotificationResponseReceivedListener'));
    expect(listenerEnd).toContain('}, [router, isBootstrapped]);');
  });

  test('the request reaches the tab through the provider value memo, deps included', () => {
    // Without the three keys in the memo's dep array the value never rebuilds,
    // so the request is silently dropped and the tab never hears about a run a
    // notice named — a lint warning, not an error, is the only other thing that
    // notices a missing dep here.
    const block = readSource('src', 'context', 'gateway-provider.tsx').match(
      /const value = useMemo<GatewayContextValue>\([\s\S]*?\n  \);/,
    )?.[0];

    expect(block).toBeDefined();
    expect(block).toContain('requestedRunFocus, requestRunFocus, clearRequestedRunFocus,');
  });
});
