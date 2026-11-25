import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import CallLinkLanding from '@/app/call';

const mockReplace = jest.fn();
const mockRouter = { replace: mockReplace };
const mockOpenBot = jest.fn();
const mockRequestSurface = jest.fn();
let mockParams: Record<string, string> = {};
let mockStatus = 'connected';

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useIsFocused: () => true,
  useLocalSearchParams: () => mockParams,
}));
jest.mock('@/context/gateway-provider', () => ({
  useGateway: () => ({
    status: mockStatus,
    openBot: mockOpenBot,
    requestSurface: mockRequestSurface,
  }),
}));
jest.mock('@/lib/voice/voice-engine-choice', () => ({
  supportsHandsfreeCalls: () => true,
}));

let tree: ReactTestRenderer;

beforeEach(() => {
  mockReplace.mockClear();
  mockOpenBot.mockReset();
  mockRequestSurface.mockClear();
  mockParams = {};
  mockStatus = 'connected';
});

afterEach(() => {
  act(() => tree?.unmount());
});

test('the Android call route opens a confirm-only chat even with autoStart parameters', async () => {
  mockParams = { engine: 'local', autoStart: '1', ts: '123', sig: 'untrusted' };
  await act(async () => {
    tree = create(<CallLinkLanding />);
  });
  expect(mockReplace).toHaveBeenCalledTimes(1);
  expect(mockReplace).toHaveBeenCalledWith({
    pathname: '/chat',
    params: { call: '1', callRequest: expect.any(String), engine: 'local' },
  });
  expect(mockOpenBot).not.toHaveBeenCalled();
});

test('a named Bot must open before the call request is handed to chat', async () => {
  mockParams = { bot: 'scout' };
  mockStatus = 'connecting';
  let resolveOpen: (opened: boolean) => void = () => undefined;
  mockOpenBot.mockReturnValue(new Promise<boolean>((resolve) => { resolveOpen = resolve; }));
  await act(async () => {
    tree = create(<CallLinkLanding />);
  });
  expect(mockOpenBot).not.toHaveBeenCalled();
  mockStatus = 'connected';
  await act(async () => {
    tree.update(<CallLinkLanding />);
  });
  expect(mockOpenBot).toHaveBeenCalledWith('scout');
  expect(mockReplace).not.toHaveBeenCalled();
  await act(async () => resolveOpen(true));
  expect(mockRequestSurface).toHaveBeenCalledWith({ kind: 'bot', botId: 'scout' });
  expect(mockReplace).toHaveBeenCalledWith({
    pathname: '/chat',
    params: { call: '1', callRequest: expect.any(String), callBot: 'scout' },
  });
});

test('a refused named Bot lands on the roster without requesting a call', async () => {
  mockParams = { bot: 'scout' };
  mockOpenBot.mockResolvedValue(false);
  await act(async () => {
    tree = create(<CallLinkLanding />);
  });
  expect(mockRequestSurface).toHaveBeenCalledWith({ kind: 'roster' });
  expect(mockReplace).toHaveBeenCalledWith('/chat');
});
