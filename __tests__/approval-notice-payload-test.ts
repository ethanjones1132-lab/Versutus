import { AppState } from 'react-native';

import {
  APPROVAL_CATEGORY_ID,
  APPROVAL_NOTICE_DATA_KIND,
} from '@/lib/notifications/categories';
import { notifyApprovalRequired } from '@/lib/notifications/local';

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

// present() refuses to post while the app is foregrounded; the tests below
// hold AppState away from 'active' so the schedule path runs.
const originalStateDescriptor = Object.getOwnPropertyDescriptor(AppState, 'currentState');

function setAppState(value: string): void {
  Object.defineProperty(AppState, 'currentState', { value, configurable: true });
}

/** The one request notifyApprovalRequired posted. */
function scheduledRequest(): {
  content: Record<string, unknown>;
  trigger: unknown;
} {
  expect(mockSchedule).toHaveBeenCalledTimes(1);
  return mockSchedule.mock.calls[0][0];
}

describe('the approval notice payload', () => {
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

  test('carries the approval marker, the run id and the gateway key', async () => {
    await notifyApprovalRequired('Ship the release?', 'run-7', 'gw-a');

    // The payload is the whole point: a tap or an action can only decide the
    // run it names, and the gateway key scopes it to the connection that
    // issued it.
    expect(scheduledRequest().content.data).toEqual({
      kind: 'approval',
      runId: 'run-7',
      gatewayKey: 'gw-a',
    });
  });

  test('the marker constant is the word the payload carries', async () => {
    await notifyApprovalRequired('Ship the release?', 'run-7', 'gw-a');

    const data = scheduledRequest().content.data as Record<string, unknown>;
    expect(data.kind).toBe(APPROVAL_NOTICE_DATA_KIND);
  });

  test('names the registered approval category, or no buttons render', async () => {
    await notifyApprovalRequired('Ship the release?', 'run-7', 'gw-a');

    // A notice may only reference a category the device has seen; the id here
    // must be the one registerNotificationCategories() registered.
    expect(scheduledRequest().content.categoryIdentifier).toBe(APPROVAL_CATEGORY_ID);
  });

  test('stays an immediate notice — approval is announced now, not scheduled', async () => {
    await notifyApprovalRequired('Ship the release?', 'run-7', 'gw-a');

    expect(scheduledRequest().trigger).toBeNull();
  });

  test('keeps the prompt as the body, truncated the same way', async () => {
    const long = 'x'.repeat(120);
    await notifyApprovalRequired(long, 'run-7', 'gw-a');

    const content = scheduledRequest().content;
    expect(content.title).toBe('Approval required');
    expect(content.body).toBe(`${'x'.repeat(80)}…`);
  });

  test('the provider hands the notice the run it is awaiting an approval for', () => {
    const src = readSource('src', 'context', 'gateway-provider.tsx');

    // One call site. The payload's run id is the guard the action path keeps,
    // so the provider must pass the run id the pending approval holds — and
    // the gateway key names the connection that issued the run.
    expect(src).toContain('setPendingRunApproval({ runId, prompt })');
    expect(src).toContain("notifyApprovalRequired(prompt, runId, activeGatewayRef.current?.id");
  });
});
