// ─── The hands-free context value is only rebuilt when it moves ─────────────
// The provider used to build the context object inline, so every render handed
// consumers a fresh value. A parent repaint, an AppState change or any state
// that the call surface does not read redrew every screen that reads the call.
// The value is now memoised on the fields it reads: a render that leaves those
// untouched keeps the same object, and a real change still publishes a new one.
//
// The test drives that seam directly: `repaint` re-renders the provider with no
// read field changed, then a read field is moved and the value must follow.

import { createElement, type ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import {
  HandsfreeVoiceProvider,
  useHandsfreeVoice,
  type HandsfreeVoiceContextValue,
} from '@/context/handsfree-voice-provider';

// The real shared value is stable across renders; a fresh object per render
// would make the memo rebuild every time and hide the defect under test.
jest.mock('react-native-reanimated', () => {
  const { useRef } = jest.requireActual('react') as typeof import('react');
  return {
    Easing: { bezier: () => (value: number) => value, elastic: () => (value: number) => value },
    useSharedValue: (value: number) => {
      const held = useRef({ value });
      return held.current;
    },
  };
});

jest.mock('@/lib/storage/key-value', () => ({
  keyValueStorage: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
  },
}));

const mockGateway = {
  activeGateway: { id: 'gw-home', url: 'http://127.0.0.1:8760', token: 'tok' },
  status: 'connected' as const,
  currentSessionId: 'ses_bot',
  selectedBotId: 'hermes',
  pendingRunApproval: null as null | { id: string },
  settings: { voiceEngine: 'auto' as const },
  sendChatInput: jest.fn(async () => 'sent' as const),
  gatewayRequest: jest.fn(async () => ({})),
  reloadHistory: jest.fn(async () => undefined),
};

const mockSurface = {
  messages: [] as unknown[],
  isSending: false,
  isCommandRunning: false,
};

jest.mock('@/context/gateway-provider', () => ({
  useGateway: () => mockGateway,
  useChatSurface: () => mockSurface,
}));

jest.mock('@/lib/notifications/push-registration', () => ({
  pushDeviceParams: jest.fn(async () => ({ deviceId: 'phone-abc12345' })),
}));

jest.mock('@/lib/voice/speech', () => ({
  beginHandsfreeCall: jest.fn(),
  endHandsfreeCall: jest.fn(),
  stopSpeech: jest.fn(async () => undefined),
}));

jest.mock('@/lib/voice/handsfree-device', () => ({
  loadHandsfreeModule: jest.fn(async () => ({
    getAvailability: jest.fn(async () => ({
      recognition: true,
      synthesis: false,
      maxSpeechInputLength: 0,
    })),
    addListener: jest.fn(() => ({ remove: () => undefined })),
  })),
}));

// ─── The provider under test ────────────────────────────────────────────────

/** The newest value the provider published. */
let published: HandsfreeVoiceContextValue | null = null;

function Probe() {
  published = useHandsfreeVoice();
  return null;
}

const tree = () => createElement(HandsfreeVoiceProvider, null, createElement(Probe) as ReactNode);

let renderer: ReactTestRenderer | null = null;

/** Read the value, failing loudly if the provider never rendered. */
function current(): HandsfreeVoiceContextValue {
  if (!published) throw new Error('the provider never rendered');
  return published;
}

beforeEach(async () => {
  mockGateway.currentSessionId = 'ses_bot';
  mockGateway.pendingRunApproval = null;
  published = null;
  await act(async () => {
    renderer = create(tree());
  });
  // The availability probe and the capabilities request answer asynchronously;
  // a mount is settled once those effects have run a turn of the queue.
  for (let round = 0; round < 4; round += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
});

afterEach(async () => {
  const mounted = renderer;
  renderer = null;
  if (mounted) {
    await act(async () => {
      mounted.unmount();
    });
  }
});

describe('the hands-free context value', () => {
  test('a repaint that changes nothing it reads keeps the same object', async () => {
    const before = current();

    await act(async () => {
      // A field the value does not read moves: the provider re-renders and the
      // published object must not.
      mockGateway.currentSessionId = 'ses_other';
      renderer!.update(tree());
    });

    expect(current()).toBe(before);
  });

  test('a read field that moves still publishes a new object', async () => {
    const before = current();
    expect(before.startBlocker).toBeNull();

    await act(async () => {
      mockGateway.pendingRunApproval = { id: 'run-1' };
      renderer!.update(tree());
    });

    expect(current()).not.toBe(before);
    expect(current().startBlocker).toBe('approval');
  });

  test('the published fields keep their values across an unread re-render', async () => {
    const before = current();

    await act(async () => {
      mockGateway.selectedBotId = 'other-bot';
      renderer!.update(tree());
    });

    const after = current();
    expect(after).toBe(before);
    expect(after.phase).toBe(before.phase);
    expect(after.transport).toBe(before.transport);
    expect(after.startBlocker).toBe(before.startBlocker);
  });
});
