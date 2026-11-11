import {
  evaluateHandsfreeStart,
  grantHandsfreeConsent,
  handsfreeCallsOffered,
  handsfreeConsentKey,
  handsfreeConsentStoreFromUnknown,
  handsfreeDeviceCanOfferCall,
  hasHandsfreeConsent,
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

  test('a Gate with voice turned off offers no call on any engine', () => {
    // S7/D7: the kill switch is not a phone-engine fallback. The offer policy
    // answers before a transport is chosen, so there is nothing to offer.
    expect(handsfreeCallsOffered({ enabled: false })).toBe(false);
    expect(handsfreeCallsOffered({ enabled: true })).toBe(true);
    expect(handsfreeCallsOffered(null)).toBe(true);
    expect(handsfreeCallsOffered({})).toBe(true);

    expect(handsfreeDeviceCanOfferCall(null, true, 'gate', false)).toBe(false);
    expect(handsfreeDeviceCanOfferCall(readySpeech, true, 'phone', false)).toBe(false);
    // An unknown answer is not a switch-off: the switch has to be said.
    expect(handsfreeDeviceCanOfferCall(null, true, 'gate', undefined)).toBe(true);
  });

  test('consent is remembered per engine and transport', () => {
    // D5: first call per engine AND transport shows the disclosure; a repeat
    // call on the same pair is one tap. A new engine, or the same engine on the
    // other transport, is a new choice.
    let store = handsfreeConsentStoreFromUnknown(null);
    expect(hasHandsfreeConsent(store, handsfreeConsentKey('local', 'gate'))).toBe(false);

    store = grantHandsfreeConsent(store, handsfreeConsentKey('local', 'gate'));
    expect(hasHandsfreeConsent(store, handsfreeConsentKey('local', 'gate'))).toBe(true);
    expect(hasHandsfreeConsent(store, handsfreeConsentKey('codex', 'gate'))).toBe(false);
    expect(hasHandsfreeConsent(store, handsfreeConsentKey('local', 'phone'))).toBe(false);
    expect(hasHandsfreeConsent(store, handsfreeConsentKey('phone', 'phone'))).toBe(false);

    store = grantHandsfreeConsent(store, handsfreeConsentKey('phone', 'phone'));
    expect(hasHandsfreeConsent(store, handsfreeConsentKey('local', 'gate'))).toBe(true);
    expect(hasHandsfreeConsent(store, handsfreeConsentKey('phone', 'phone'))).toBe(true);
  });

  test('only an explicit true counts as consent, so a bad blob asks again', () => {
    const store = handsfreeConsentStoreFromUnknown({
      'gate:local': 'yes',
      'gate:codex': 1,
      'gate:phone': {},
      'phone:phone': true,
    });
    expect(store).toEqual({ 'phone:phone': true });
    expect(handsfreeConsentStoreFromUnknown('not a record')).toEqual({});
    expect(handsfreeConsentStoreFromUnknown(['gate:local'] as unknown)).toEqual({});
  });
});
