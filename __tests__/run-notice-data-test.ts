import { AppState } from 'react-native';

import { notifyRunComplete } from '@/lib/notifications/local';
import { RUN_NOTICE_DATA_KIND, routeForTap } from '@/lib/notifications/tap-route';

jest.mock('expo-notifications', () => ({
  scheduleNotificationAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
}));

import * as Notifications from 'expo-notifications';

const mockSchedule = Notifications.scheduleNotificationAsync as jest.Mock;

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

const provider = () => readSource('src', 'context', 'gateway-provider.tsx');
const local = () => readSource('src', 'lib', 'notifications', 'local.ts');

// present() refuses to post while the app is foregrounded; the tests below
// hold AppState away from 'active' so the schedule path runs.
const originalStateDescriptor = Object.getOwnPropertyDescriptor(AppState, 'currentState');

function setAppState(value: string): void {
  Object.defineProperty(AppState, 'currentState', { value, configurable: true });
}

/** The one request notifyRunComplete posted. */
function scheduledRequest(): {
  content: Record<string, unknown>;
  trigger: unknown;
} {
  expect(mockSchedule).toHaveBeenCalledTimes(1);
  return mockSchedule.mock.calls[0][0];
}

describe('the run notice payload', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setAppState('background');
    // Grant the permission flow so present() reaches scheduleNotificationAsync.
    (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });
    mockSchedule.mockResolvedValue('notif-1');
  });

  afterAll(() => {
    if (originalStateDescriptor) {
      Object.defineProperty(AppState, 'currentState', originalStateDescriptor);
    }
  });

  test('carries the run marker and the run id, so a tap knows which run', async () => {
    await notifyRunComplete('Run complete', 'shipped the release', 'run-7');

    // The payload is the whole point: a run notice that names no run is a
    // notice the tap router refuses, and the tap then falls back to Activity
    // without knowing which run it was about.
    expect(scheduledRequest().content.data).toEqual({ kind: 'run', runId: 'run-7' });
  });

  test('the posted payload is the route the tap router reads back', async () => {
    await notifyRunComplete('Run finished', 'the run failed', 'run-9');

    // End to end through the consumer: the producer's payload must route as a
    // run, not merely contain the right keys.
    expect(routeForTap(scheduledRequest().content.data)).toEqual({
      kind: 'run',
      runId: 'run-9',
    });
  });

  test('the marker constant is the word the payload carries', async () => {
    await notifyRunComplete('Run complete', 'done', 'run-7');

    const data = scheduledRequest().content.data as Record<string, unknown>;
    expect(data.kind).toBe(RUN_NOTICE_DATA_KIND);
  });

  test('stays an immediate notice — a settled run is announced now, not scheduled', async () => {
    await notifyRunComplete('Run complete', 'done', 'run-7');

    expect(scheduledRequest().trigger).toBeNull();
  });

  test('wears no category: a run notice offers no buttons', async () => {
    await notifyRunComplete('Run complete', 'done', 'run-7');

    // The run notice is informational. If it ever referenced a category the
    // device has not registered, the buttons would be missing or wrong — and
    // there is nothing to decide from a run that has already settled.
    expect(scheduledRequest().content).not.toHaveProperty('categoryIdentifier');
  });

  test('keeps the settled copy exactly as the caller worded it', async () => {
    await notifyRunComplete('Run unconfirmed', 'the gateway never said', 'run-7');

    const content = scheduledRequest().content;
    expect(content.title).toBe('Run unconfirmed');
    expect(content.body).toBe('the gateway never said');
  });

  test('the provider names the run it settled at both call sites', () => {
    const src = provider();

    // Two run notices exist, and neither may be posted without its run:
    // the run this app drove to completion, and each run the disconnect
    // settle path resolved.
    expect(src.match(/notifyRunComplete\(/g)).toHaveLength(2);
    expect(src).toMatch(
      /notifyRunComplete\(\s*status === 'complete'[\s\S]*?summary \|\| outcome\.status,\s*trackedId\.current,/,
    );
    expect(src).toMatch(
      /notifyRunComplete\(\s*run\.status === 'complete' \? 'Run complete' : 'Run finished',\s*run\.summary \?\? run\.status,\s*run\.id,/,
    );
  });

  test('the gateway-down notice keeps its own payload', () => {
    const src = local();

    // The must-still: the run marker is the only payload added here. The
    // gateway-down notice keeps passing the builder that scopes it to one
    // gateway, so recovery still retires exactly that notice.
    expect(src).toContain('gatewayDownNoticeData(gatewayKey)');
  });
});
