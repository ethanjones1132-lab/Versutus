// ─── Relay notification channels + foreground policy (Solution A3) ─────────
// Three Android channels are created once per process, beside the run-progress
// one, so a relayed approval, reply or routine result lands on a channel its
// own importance names. The foreground handler is the display policy: a notice
// arriving while the operator already has the stream on screen is not stacked
// on top of it, while background and killed still present. The startup wiring
// is pinned off the source, the way every provider suite here pins it.

import { AppState } from 'react-native';

import {
  APPROVALS_CHANNEL_ID,
  MODEL_REPLIES_CHANNEL_ID,
  ROUTINE_RESULTS_CHANNEL_ID,
  ensurePushChannels,
  installForegroundNotificationHandler,
} from '@/lib/notifications/local';

jest.mock('expo-notifications', () => ({
  // The real enum's values (NotificationChannelManager.types.d.ts:24-36). A
  // mock answering anything else would pin channels the phone would never build.
  AndroidImportance: { HIGH: 6, DEFAULT: 5 },
  setNotificationChannelAsync: jest.fn(),
  setNotificationHandler: jest.fn(),
}));

import * as Notifications from 'expo-notifications';

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(...parts: string[]): string {
  return nodeFs.readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8').replace(/\r\n/g, '\n');
}

const layout = () => readSource('src', 'app', '_layout.tsx');

const mockChannel = Notifications.setNotificationChannelAsync as jest.Mock;
const mockHandler = Notifications.setNotificationHandler as jest.Mock;

const originalStateDescriptor = Object.getOwnPropertyDescriptor(AppState, 'currentState');

function setAppState(value: string): void {
  Object.defineProperty(AppState, 'currentState', { value, configurable: true });
}

describe('ensurePushChannels', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockChannel.mockResolvedValue(undefined);
  });

  afterAll(() => {
    if (originalStateDescriptor) {
      Object.defineProperty(AppState, 'currentState', originalStateDescriptor);
    }
  });

  test('creates the three relay channels, each at its own importance', async () => {
    await ensurePushChannels();

    const registered = new Map<string, { name: string; importance: number }>(
      mockChannel.mock.calls.map(([id, options]: [string, { name: string; importance: number }]) => [
        id,
        options,
      ]),
    );
    expect([...registered.keys()].sort()).toEqual(
      [APPROVALS_CHANNEL_ID, MODEL_REPLIES_CHANNEL_ID, ROUTINE_RESULTS_CHANNEL_ID].sort(),
    );
    expect(registered.get(APPROVALS_CHANNEL_ID)?.importance).toBe(
      Notifications.AndroidImportance.HIGH,
    );
    expect(registered.get(MODEL_REPLIES_CHANNEL_ID)?.importance).toBe(
      Notifications.AndroidImportance.DEFAULT,
    );
    expect(registered.get(ROUTINE_RESULTS_CHANNEL_ID)?.importance).toBe(
      Notifications.AndroidImportance.DEFAULT,
    );
  });

  test('the ids are the relay spellings, and the importances are the platform enum', () => {
    expect(APPROVALS_CHANNEL_ID).toBe('approvals');
    expect(MODEL_REPLIES_CHANNEL_ID).toBe('model-replies');
    expect(ROUTINE_RESULTS_CHANNEL_ID).toBe('routine-results');
    // The runtime case above reads the mocked values; this is the assertion that
    // the code asked the platform for HIGH and DEFAULT.
    const src = readSource('src', 'lib', 'notifications', 'local.ts');
    expect(src).toContain('Notifications.AndroidImportance.HIGH');
    expect(src).toContain('Notifications.AndroidImportance.DEFAULT');
  });
});

describe('installForegroundNotificationHandler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    if (originalStateDescriptor) {
      Object.defineProperty(AppState, 'currentState', originalStateDescriptor);
    }
  });

  test('draws nothing while active, and presents in the background', async () => {
    installForegroundNotificationHandler();

    expect(mockHandler).toHaveBeenCalledTimes(1);
    const handler = mockHandler.mock.calls[0][0].handleNotification as () => Promise<{
      shouldShowBanner: boolean;
      shouldShowList: boolean;
      shouldPlaySound: boolean;
      shouldSetBadge: boolean;
    }>;

    setAppState('active');
    const active = await handler();
    expect(active.shouldShowBanner).toBe(false);
    expect(active.shouldShowList).toBe(false);
    expect(active.shouldPlaySound).toBe(false);

    setAppState('background');
    const background = await handler();
    expect(background.shouldShowBanner).toBe(true);
    expect(background.shouldShowList).toBe(true);
  });
});

describe('the startup wiring', () => {
  const categoriesEffect = (): string =>
    layout()
      .match(/useEffect\(\(\) => \{[\s\S]*?\}, \[\]\);/g)
      ?.find((block) => block.includes('registerNotificationCategories')) ?? '';

  test('the categories mount effect also ensures the relay channels', () => {
    expect(categoriesEffect()).toContain('ensurePushChannels');
    expect(layout()).toContain("from '@/lib/notifications/local'");
  });

  test('the same effect installs the foreground presentation policy', () => {
    expect(categoriesEffect()).toContain('installForegroundNotificationHandler');
  });
});
