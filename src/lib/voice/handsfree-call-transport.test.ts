// ─── One transport decision for the offer and the start ─────────────────────
// The Call control used to decide its transport from the stored preference
// (`phone` or not), while `handleStartCall` decided from the Gate's resolved
// engine. A non-phone preference could therefore offer a Gate call that the
// start opened on the phone — and with no recognizer, the tap failed. These
// tests pin the single decision both paths now share, and fail if either path
// goes back to deciding on its own.

import {
  evaluateHandsfreeStart,
  handsfreeDeviceCanOfferCall,
  handsfreeTransportForCall,
  type HandsfreeStartAvailability,
  type HandsfreeStartEvaluation,
  type HandsfreeStartTransport,
} from '@/lib/voice/handsfree-start-reason';
import type { VoiceEnginePreference } from '@/lib/voice/voice-engine-choice';

import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AppState } from 'react-native';
import { HandsfreeVoiceProvider, useHandsfreeVoice } from '@/context/handsfree-voice-provider';

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(...parts: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', '..', '..', ...parts].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

function between(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  if (start === -1) return '';
  const rest = src.slice(start + startMarker.length);
  const end = rest.indexOf(endMarker);
  return end === -1 ? rest : rest.slice(0, end);
}

const provider = readSource('src', 'context', 'handsfree-voice-provider.tsx');
const screen = readSource('src', 'components', 'chat', 'chat-screen.tsx');

const readySpeech: HandsfreeStartAvailability = {
  recognition: true,
  synthesis: true,
  maxSpeechInputLength: 4000,
};

/** Everything a start needs except the transport under test. */
const connected: HandsfreeStartEvaluation = {
  phase: 'idle',
  appState: 'active',
  status: 'connected',
  gatewayId: 'gw-1',
  targetGatewayId: 'gw-1',
  isSending: false,
  isCommandRunning: false,
  pendingRunApproval: false,
  moduleLoaded: true,
  availability: readySpeech,
  transport: 'phone',
  gatewayUrl: 'http://gate.local:8760',
  sessionId: 's1',
};

type AgreementCase = {
  name: string;
  preference: VoiceEnginePreference;
  engine: string | undefined;
  availability: HandsfreeStartAvailability | null;
  transport: HandsfreeStartTransport;
  offered: boolean;
};

const cases: AgreementCase[] = [
  {
    name: 'a phone preference stays on the phone',
    preference: 'phone',
    engine: 'phone',
    availability: readySpeech,
    transport: 'phone',
    offered: true,
  },
  {
    name: 'a phone preference with no recognizer is not offered',
    preference: 'phone',
    engine: 'phone',
    availability: { recognition: false, synthesis: true, maxSpeechInputLength: 4000 },
    transport: 'phone',
    offered: false,
  },
  {
    name: 'a phone preference with an unreadable probe is not offered',
    preference: 'phone',
    engine: 'phone',
    availability: null,
    transport: 'phone',
    offered: false,
  },
  {
    name: 'a resolved Gate engine offers without phone speech',
    preference: 'local',
    engine: 'local',
    availability: null,
    transport: 'gate',
    offered: true,
  },
  {
    name: 'a non-phone preference that fell back to phone follows the phone blocker',
    preference: 'auto',
    engine: 'phone',
    availability: { recognition: true, synthesis: false, maxSpeechInputLength: 4000 },
    transport: 'phone',
    offered: false,
  },
  {
    name: 'an unresolved non-phone preference keeps the Gate',
    preference: 'local',
    engine: undefined,
    availability: null,
    transport: 'gate',
    offered: true,
  },
  {
    name: 'an auto preference resolved to Codex keeps the Gate',
    preference: 'auto',
    engine: 'codex',
    availability: null,
    transport: 'gate',
    offered: true,
  },
];

describe('the Call offer and the start path share one transport decision', () => {
  test.each(cases)('$name', ({ preference, engine, availability, transport, offered }) => {
    const decided = handsfreeTransportForCall(engine, preference);
    expect(decided).toBe(transport);

    const canOffer = handsfreeDeviceCanOfferCall(availability, true, decided);
    const decision = evaluateHandsfreeStart({ ...connected, transport: decided, availability });
    const canStart = decision.kind !== 'stop';

    // If these ever disagree, the Call control is offered for a transport the
    // start will not use — the defect this slice closes.
    expect(canOffer).toBe(canStart);
    expect(canOffer).toBe(offered);
  });

  test('the provider decides the offered transport with the shared rule', () => {
    const canStart = between(provider, 'const canStart =', ';');
    expect(provider).toContain('handsfreeTransportForCall(');
    expect(canStart).toMatch(
      /handsfreeDeviceCanOfferCall\(\s*availability,\s*nativeModuleLoaded,\s*transport,?\s*\)/,
    );
  });

  test('the start path uses the provider’s transport instead of re-deciding it', () => {
    const start = between(screen, 'const handleStartCall = useCallback(', '}, [activeGateway');
    expect(start).toContain('const decidedTransport = handsfree.transport ?? transport');
    expect(start).toContain('transport: decidedTransport');
  });

  test('a newly connected gateway never inherits the previous gateway’s engine', () => {
    // The capabilities answer is tagged with the gateway that answered, and the
    // transport only reads the tag matching the currently connected gateway:
    // after a gateway switch or reconnect the choice is unknown until the new
    // gateway’s own request settles, so the offer can’t pin the wrong transport.
    expect(provider).toContain('{ gatewayId, capabilities }');
    expect(provider).toMatch(
      /voiceCapabilities\.gatewayId === gatewayId\s*&&\s*status === 'connected'/,
    );
  });
});


// Exercise the real provider across a same-Gateway reconnect. A source-string
// assertion cannot detect a retained answer from the previous connection.
jest.mock('react-native-reanimated', () => ({
  useSharedValue: (value: number) => ({ value }),
  Easing: { bezier: () => (value: number) => value, elastic: () => (value: number) => value },
}));
jest.mock('@/lib/storage/key-value', () => ({
  keyValueStorage: { getItem: jest.fn(async () => null), setItem: jest.fn(async () => undefined), removeItem: jest.fn(async () => undefined) },
}));
jest.mock('@/lib/notifications/push-registration', () => ({
  pushDeviceParams: jest.fn(async () => ({ deviceId: 'phone-test' })),
}));
jest.mock('@/lib/voice/speech', () => ({
  beginHandsfreeCall: jest.fn(), endHandsfreeCall: jest.fn(), stopSpeech: jest.fn(async () => undefined),
}));
jest.mock('@/lib/voice/handsfree-device', () => ({
  loadHandsfreeModule: jest.fn(async () => ({
    getAvailability: jest.fn(async () => ({ recognition: true, synthesis: true, maxSpeechInputLength: 4000 })),
  })),
}));
const mockConnection = {
  activeGateway: { id: 'gw-1', url: 'http://gate.test:8760' },
  status: 'connected' as string,
  currentSessionId: 's1', selectedBotId: undefined, pendingRunApproval: null,
  settings: { voiceEngine: 'auto' as const },
  sendChatInput: jest.fn(), gatewayRequest: jest.fn(), reloadHistory: jest.fn(),
};
const mockSurface = { messages: [], isSending: false, isCommandRunning: false };
jest.mock('@/context/gateway-provider', () => ({
  useGateway: () => mockConnection, useChatSurface: () => mockSurface,
}));


const mockTransports: string[] = [];
function TransportProbe() {
  mockTransports.push(useHandsfreeVoice().transport);
  return null;
}

test('a same-Gateway reconnect waits for its own capabilities before choosing phone', async () => {
  const oldCapabilities = { enabled: false, engines: { local: { state: 'disabled' }, codex: { state: 'disabled' } } };
  let resolveNew!: (value: typeof oldCapabilities) => void;
  const newReply = new Promise<typeof oldCapabilities>((resolve) => { resolveNew = resolve; });
  mockConnection.gatewayRequest.mockResolvedValueOnce(oldCapabilities).mockReturnValueOnce(newReply);
  mockConnection.status = 'connected';
  mockTransports.length = 0;
  AppState.currentState = 'active';
  let renderer: ReactTestRenderer | undefined;
  const tree = () => createElement(HandsfreeVoiceProvider, null, createElement(TransportProbe));
  try {
    await act(async () => { renderer = create(tree()); });
    expect(mockTransports[mockTransports.length - 1]).toBe('phone');
    mockConnection.status = 'disconnected';
    await act(async () => { renderer!.update(tree()); });
    mockConnection.status = 'connected';
    await act(async () => { renderer!.update(tree()); });
    expect(mockConnection.gatewayRequest).toHaveBeenCalledTimes(2);
    expect(mockTransports[mockTransports.length - 1]).toBe('gate');
    await act(async () => { resolveNew(oldCapabilities); });
    expect(mockTransports[mockTransports.length - 1]).toBe('phone');
  } finally {
    if (renderer) await act(async () => { renderer!.unmount(); });
  }
});
