import {
  evaluateHandsfreeStart,
  handsfreeDeviceCanOfferCall,
  type HandsfreeStartEvaluation,
} from '@/lib/voice/handsfree-start-reason';

const readySpeech = { recognition: true, synthesis: true, maxSpeechInputLength: 4000 };

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
  transport: 'gate',
  gatewayUrl: 'http://gate.local:8760',
  sessionId: 's1',
};

describe('hands-free Call offer policy', () => {
  test('a loaded native module offers a Gate call when phone availability is unreadable', () => {
    expect(handsfreeDeviceCanOfferCall(null, true, 'gate')).toBe(true);
    expect(
      evaluateHandsfreeStart({
        ...connected,
        transport: 'gate',
        availability: null,
        availabilityError: true,
      }),
    ).toEqual({ kind: 'gate' });
  });

  test('the native media module is still required to offer or start a call', () => {
    expect(handsfreeDeviceCanOfferCall(null, false, 'gate')).toBe(false);
    expect(evaluateHandsfreeStart({ ...connected, moduleLoaded: false })).toEqual({
      kind: 'stop',
      result: 'no-native-module',
    });
  });

  test('phone transport still requires recognition and synthesis', () => {
    expect(
      handsfreeDeviceCanOfferCall(
        { recognition: false, synthesis: true, maxSpeechInputLength: 4000 },
        true,
        'phone',
      ),
    ).toBe(false);
    expect(
      handsfreeDeviceCanOfferCall(
        { recognition: true, synthesis: false, maxSpeechInputLength: 0 },
        true,
        'phone',
      ),
    ).toBe(false);
    expect(
      evaluateHandsfreeStart({
        ...connected,
        transport: 'phone',
        availability: { recognition: false, synthesis: true, maxSpeechInputLength: 4000 },
      }),
    ).toEqual({ kind: 'stop', result: 'phone-recognition-unavailable' });
    expect(
      evaluateHandsfreeStart({
        ...connected,
        transport: 'phone',
        availability: { recognition: true, synthesis: false, maxSpeechInputLength: 0 },
      }),
    ).toEqual({ kind: 'stop', result: 'phone-synthesis-unavailable' });
  });

  test('disconnection, busy work, and pending approval still refuse a Gate start', () => {
    const safeguards: Partial<HandsfreeStartEvaluation>[] = [
      { status: 'reconnecting' },
      { isSending: true },
      { isCommandRunning: true },
      { pendingRunApproval: true },
    ];

    for (const safeguard of safeguards) {
      expect(
        evaluateHandsfreeStart({
          ...connected,
          transport: 'gate',
          availability: null,
          ...safeguard,
        }),
      ).toEqual({ kind: 'stop', result: 'refused' });
    }
  });
});
