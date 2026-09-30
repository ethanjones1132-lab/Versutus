import { createElement, type ElementType } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { TerminalScreen } from '@/components/terminal/terminal-screen';
import { useGateway } from '@/context/gateway-provider';
import { openTerminalSession, sendTerminalInput } from '@/lib/terminal/client';

jest.mock('react-native-reanimated', () => ({
  Easing: { bezier: () => (value: number) => value, elastic: () => (value: number) => value },
}));
jest.mock('@/context/gateway-provider', () => ({ useGateway: jest.fn() }));
jest.mock('@/hooks/use-tokens', () => ({
  useTokens: () => ({
    backgroundInset: '#000',
    border: '#333',
    statusConnected: '#0f0',
    statusConnecting: '#ff0',
    accent: '#0af',
    accentWarm: '#fa0',
    tertiary: '#999',
  }),
}));
jest.mock('expo-router', () => ({ useRouter: () => ({ replace: jest.fn() }) }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));
jest.mock('expo-haptics', () => ({
  notificationAsync: jest.fn(),
  impactAsync: jest.fn(),
  NotificationFeedbackType: { Success: 'success', Error: 'error' },
  ImpactFeedbackStyle: { Light: 'light' },
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0, top: 0 }) }));
jest.mock('@/lib/terminal/client', () => ({
  openTerminalSession: jest.fn(),
  sendTerminalInput: jest.fn(),
}));
jest.mock('@/components/ui', () => ({
  Button: 'Button',
  Card: 'Card',
  Chip: 'Chip',
  EmptyState: 'EmptyState',
  ErrorCard: 'ErrorCard',
  PageTitle: 'PageTitle',
  Screen: 'Screen',
  Text: 'Text',
  TextField: 'TextField',
}));
jest.mock('@/components/terminal/mode-picker', () => ({
  TerminalModePicker: 'TerminalModePicker',
}));
jest.mock('@/components/terminal/terminal-output', () => ({ TerminalOutput: 'TerminalOutput' }));
jest.mock('@/components/terminal/command-log-sheet', () => ({ CommandLogSheet: 'CommandLogSheet' }));
jest.mock('@/components/terminal/command-result-view', () => ({ CommandResultView: 'CommandResultView' }));
jest.mock('@/components/gateway/gateway-command-panel', () => ({ GatewayCommandPanel: 'GatewayCommandPanel' }));
jest.mock('@/components/chat/chat-empty-state', () => ({ ChatEmptyState: 'ChatEmptyState' }));
jest.mock('@/components/layout/ComposerKeyboardLift', () => ({ ComposerKeyboardLift: 'ComposerKeyboardLift' }));
jest.mock('@/components/connection-badge', () => ({
  PulsingDot: 'PulsingDot',
  statusColor: () => '#fff',
  statusLabel: () => 'connected',
}));
jest.mock('@/components/nav/drawer-menu-button', () => ({ DrawerMenuButton: 'DrawerMenuButton' }));
jest.mock('@/lib/motion/ambient-parallax', () => ({ useAmbientParallaxScroll: () => ({ parallaxY: { value: 0 }, onScroll: jest.fn() }) }));
jest.mock('@/lib/motion/screen-edges', () => ({ screenEdgesFor: () => ['top'] }));
jest.mock('@/lib/terminal/output', () => ({ appendTerminalChunk: jest.fn() }));
jest.mock('@/lib/terminal/ansi', () => ({ ansiPlainText: (s: string) => s }));
jest.mock('@/lib/terminal/keyboard-behavior', () => ({ terminalKeyboardBehavior: () => 'padding' }));
jest.mock('@/lib/terminal/rpc-insets', () => ({ terminalRpcContentPaddingBottom: () => 0 }));
jest.mock('@/lib/gateway/dashboard', () => ({
  agentCommands: () => [],
  filterExecutableCommands: () => [],
  homeQuickCommands: () => [],
  summarizeCommandResult: () => '',
}));

const gateway = (id: string) => ({ id, url: 'http://localhost', token: 't', name: 'GW' });

// Stand-in host names for the mocked UI primitives; not real JSX intrinsics,
// so they need an ElementType cast for findAllByType.
const TEXT_FIELD = 'TextField' as ElementType;
const BUTTON = 'Button' as ElementType;
const MODE_PICKER = 'TerminalModePicker' as ElementType;

function mockGatewayState(id: string, status: string) {
  jest.mocked(useGateway).mockReturnValue({
    activeGateway: gateway(id),
    activeHello: null,
    status,
    statusDetail: null,
    settings: {},
    retryAutoConnect: jest.fn(),
    gatewayRequest: jest.fn(),
    runAgentCommand: jest.fn(),
    capabilitySnapshot: {
      status: 'fresh',
      groups: [{ id: 'terminal', status: 'ready' }],
      methods: {},
    },
  } as never);
}

describe('terminal session survival', () => {
  let renderer: ReactTestRenderer;
  let session: { sid: string; close: jest.Mock };

  beforeEach(() => {
    jest.useFakeTimers();
    session = { sid: 'sess-1', close: jest.fn() };
    jest.mocked(openTerminalSession).mockReset();
    jest.mocked(openTerminalSession).mockResolvedValue(session as never);
    jest.mocked(sendTerminalInput).mockReset();
    jest.mocked(sendTerminalInput).mockResolvedValue(undefined);
  });

  afterEach(async () => {
    if (renderer) await act(async () => { renderer.unmount(); });
    renderer = null as never;
    jest.useRealTimers();
  });

  async function mount(id: string, status: string) {
    mockGatewayState(id, status);
    await act(async () => { renderer = create(createElement(TerminalScreen)); });
    // Tools opens on RPC; the live shell only exists once Shell is picked.
    await act(async () => { renderer.root.findByType(MODE_PICKER).props.onModeChange('shell'); });
    await act(async () => { jest.runOnlyPendingTimers(); });
  }

  test('a status blip (connected -> reconnecting -> connected) does not close the session', async () => {
    await mount('gw-1', 'connected');
    expect(openTerminalSession).toHaveBeenCalledTimes(1);
    session.close.mockClear();

    mockGatewayState('gw-1', 'reconnecting');
    await act(async () => { renderer.update(createElement(TerminalScreen)); });
    expect(session.close).not.toHaveBeenCalled();

    mockGatewayState('gw-1', 'connected');
    await act(async () => { renderer.update(createElement(TerminalScreen)); });
    expect(session.close).not.toHaveBeenCalled();
  });

  test('a gateway change closes the old session', async () => {
    await mount('gw-1', 'connected');
    expect(openTerminalSession).toHaveBeenCalledTimes(1);
    session.close.mockClear();

    mockGatewayState('gw-2', 'connected');
    await act(async () => { renderer.update(createElement(TerminalScreen)); });
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  test('a failed send restores the input text', async () => {
    await mount('gw-1', 'connected');
    jest.mocked(sendTerminalInput).mockRejectedValue(new Error('Terminal input failed (500)'));

    const textField = renderer.root.findAllByType(TEXT_FIELD)[0];
    await act(async () => { textField.props.onChangeText('ls -la'); });

    const sendButton = renderer.root.findAllByType(BUTTON).find(
      (b) => b.props.label === 'Send',
    );
    expect(sendButton).toBeDefined();
    await act(async () => { sendButton!.props.onPress(); });
    await act(async () => { jest.runOnlyPendingTimers(); });

    const updated = renderer.root.findAllByType(TEXT_FIELD)[0];
    expect(updated.props.value).toBe('ls -la');
  });
});
