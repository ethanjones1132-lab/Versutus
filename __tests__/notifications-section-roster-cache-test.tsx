// ─── The Bot filter's roster read, on the operator's side of the wire ──────
// The Bot filter is a roster read, and the Settings screen used to run its own:
// a fourth uncached `/v1/bots` on every connect, beside Chat's, the drawer's and
// the widget's, against a host the repo documents as serving one request at a
// time. A refused read was worse than slow — it cleared the filter, so a blip
// turned a working list into "no Bots" and left the stored allowlist showing as
// unknown ids.
//
// These pin the stale-while-revalidate half: the remembered roster paints before
// the read is, a connect inside the freshness window reads nothing at all, a
// refused re-read keeps the list on screen, and two cards mounting together
// spend one read.
//
// The Gate is a fake whose replies this file releases by hand.

import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { NotificationsSection } from '@/components/gateway/notifications-section';

const mockRequest = jest.fn();
const mockPermissionRead = jest.fn();
// The roster effect reads `listBots` off the context, so a fresh jest.fn on
// every render would re-run that effect forever.
const mockListBots = jest.fn();
jest.mock('@/components/ui', () => ({
  Button: 'Button',
  Card: 'Card',
  ErrorCard: 'ErrorCard',
  Icon: 'Icon',
  Skeleton: 'Skeleton',
  Text: 'Text',
  TextField: 'TextField',
}));
jest.mock('@/context/gateway-provider', () => ({
  useGateway: () => mockGateway,
}));
jest.mock('expo-notifications', () => ({
  getPermissionsAsync: () => mockPermissionRead(),
  requestPermissionsAsync: jest.fn(),
}));
jest.mock('@/lib/notifications/push-registration', () => ({
  pushDeviceParams: jest.fn().mockResolvedValue({ deviceId: 'test-device' }),
  syncPushRegistration: jest.fn(),
}));

// tokens.ts only needs Easing for Motion curves; reanimated's native worklet
// unpackers cannot load under jest-expo.
jest.mock('react-native-reanimated', () => ({
  Easing: {
    bezier: () => (value: number) => value,
    elastic: () => (value: number) => value,
  },
}));

const mockGateway = {
  activeGateway: { id: 'gw-1', kind: 'custom' } as { id: string; kind: string },
  status: 'connected',
  gatewayRequest: mockRequest,
  listBots: mockListBots,
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const GRANTED = { granted: true, status: 'granted', canAskAgain: false };
const ALPHA = { id: 'bot-a', displayName: 'Alpha' };
/** The one roster this file ever sees; the gate is whether it is still there. */
const STORED: Record<string, unknown> = {
  enabled: true,
  richBody: true,
  widgetUpdates: false,
  botIds: ['bot-a'],
  quietHours: { startMinutes: 1320, endMinutes: 420 },
  quietHoursAllowApprovals: false,
};

/** Past the freshness window the roster effect shares. */
const PAST_THE_WINDOW = 31_000;

let renderer: ReactTestRenderer;

async function flush(): Promise<void> {
  for (let round = 0; round < 6; round += 1) {
    await act(async () => {
      jest.advanceTimersByTime(0);
    });
  }
}

async function mount(): Promise<void> {
  await act(async () => {
    renderer = create(createElement(NotificationsSection));
  });
  await flush();
}

/** A `connected` transition: out to the quiet line and back onto the Gate. */
async function reconnect(): Promise<void> {
  mockGateway.status = 'disconnected';
  await act(async () => {
    renderer.update(createElement(NotificationsSection));
  });
  await flush();
  mockGateway.status = 'connected';
  await act(async () => {
    renderer.update(createElement(NotificationsSection));
  });
  await flush();
}

type Control = { props: { accessibilityLabel?: unknown } };

/**
 * The Bot-filter switch rows, by the label the card gives each one — optionally
 * narrowed to one Bot. Matched on both ends so the quiet-hours "Allow approval
 * notices" row is not one of them, and de-duplicated because the real
 * `Switch` forwards the same label down to each of its own layers.
 */
function botRows(name?: string): Control[] {
  const found = renderer.root.findAll(
    (node) =>
      typeof node.props?.accessibilityLabel === 'string' &&
      node.props.accessibilityLabel.startsWith(name ? `Allow ${name} notifications` : 'Allow ') &&
      node.props.accessibilityLabel.endsWith(' notifications'),
  ) as unknown as Control[];
  const firstOfEach = new Map<string, Control>();
  for (const node of found) {
    const label = String(node.props.accessibilityLabel);
    if (!firstOfEach.has(label)) firstOfEach.set(label, node);
  }
  return [...firstOfEach.values()];
}

function screen(): string {
  const strings = (node: unknown): string[] => {
    if (typeof node === 'string') return [node];
    if (Array.isArray(node)) return node.flatMap(strings);
    if (node && typeof node === 'object' && 'children' in node) {
      return strings((node as { children: unknown }).children);
    }
    return [];
  };
  return strings(renderer.toJSON()).join(' ');
}

beforeEach(() => {
  jest.useFakeTimers();
  // A gateway id per test: the roster cache is module level, and keying it is
  // also what keeps one test's answer out of the next one's connect.
  mockGateway.activeGateway = { id: `gw-${Math.random().toString(36).slice(2)}`, kind: 'custom' };
  mockGateway.status = 'connected';
  mockPermissionRead.mockReset().mockResolvedValue(GRANTED);
  mockListBots.mockReset().mockResolvedValue([ALPHA]);
  mockRequest.mockReset().mockImplementation(() => Promise.resolve({ ...STORED }));
});

afterEach(async () => {
  if (renderer) await act(async () => { renderer.unmount(); });
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test('two connects inside the freshness window spend one roster read', async () => {
  await mount();
  expect(mockListBots).toHaveBeenCalledTimes(1);

  // A blip: the card unmounts its rows, the same Gate comes straight back. The
  // roster it answered a second ago is still that answer, so the reconnect must
  // not spend a second `/v1/bots` on it.
  await reconnect();

  expect(mockListBots).toHaveBeenCalledTimes(1);
  expect(botRows()).toHaveLength(1);
});

test('a refused re-read keeps the Bots the operator was looking at', async () => {
  await mount();
  expect(botRows('Alpha')).toHaveLength(1);

  // Past the freshness window, so this connect really does re-read — and the
  // Gate is not answering. Blanking the list here told the operator "no Bots"
  // about a Gate that had one a moment ago.
  await act(async () => {
    jest.advanceTimersByTime(PAST_THE_WINDOW);
  });
  mockListBots.mockRejectedValue(new Error('the Gate refused the roster read'));
  await reconnect();

  expect(mockListBots).toHaveBeenCalledTimes(2);
  expect(botRows('Alpha')).toHaveLength(1);
  expect(screen()).not.toContain('unknown id');
});

test('a failed first read shows the empty filter and raises nothing', async () => {
  mockListBots.mockRejectedValue(new Error('the Gate refused the roster read'));
  await mount();

  // Nothing has ever been read for this gateway, so there is nothing to keep —
  // but the card settles rather than rejecting into the void.
  expect(mockListBots).toHaveBeenCalledTimes(1);
  expect(botRows()).toHaveLength(1);
  expect(screen()).toContain('unknown id');
});

test('the remembered roster paints before the revalidation answers', async () => {
  await mount();
  await act(async () => {
    renderer.unmount();
  });

  // Reopen the card with the read still in the air: the list this device
  // already has must be the one on screen, not a blank filter.
  await act(async () => {
    jest.advanceTimersByTime(PAST_THE_WINDOW);
  });
  const pending = deferred<typeof ALPHA[]>();
  mockListBots.mockReturnValue(pending.promise);
  await act(async () => {
    renderer = create(createElement(NotificationsSection));
  });
  await flush();

  expect(mockListBots).toHaveBeenCalledTimes(2);
  expect(botRows('Alpha')).toHaveLength(1);

  pending.resolve([]);
  await flush();
  // An empty-but-ok answer is the host telling the truth, and it is believed.
  expect(botRows()).toHaveLength(1);
  expect(screen()).toContain('unknown id');
});

test('two cards on screen at once share one read', async () => {
  const pending = deferred<typeof ALPHA[]>();
  mockListBots.mockReturnValue(pending.promise);

  await act(async () => {
    renderer = create(
      createElement(
        'Host',
        null,
        createElement(NotificationsSection),
        createElement(NotificationsSection),
      ),
    );
  });
  await flush();

  // Both cards mounted together and neither can see the other's in-flight read
  // through React: the sharing has to be outside the component.
  expect(mockListBots).toHaveBeenCalledTimes(1);

  pending.resolve([ALPHA]);
  await flush();
  // `botRows` de-duplicates by label, which two cards share — so the row itself
  // is counted on the rendered text instead.
  expect(screen().match(/Alpha/g)).toHaveLength(2);
});
