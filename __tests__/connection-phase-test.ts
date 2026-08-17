import { decideConnectionPhase } from '@/lib/connection/phase';

describe('decideConnectionPhase', () => {
  test('connected clears retry state, the down notice, and any last error', () => {
    const decision = decideConnectionPhase('connecting', 'connected');
    expect(decision).toEqual({
      phase: 'connected',
      clearAutoRetryTimer: true,
      clearGatewayDownNotified: true,
      clearProbeMessage: true,
      clearLastError: true,
      notifyGatewayDown: false,
      scheduleAutoRetry: false,
    });
  });

  test('a fresh connecting attempt clears the last error', () => {
    const decision = decideConnectionPhase('failed', 'connecting');
    expect(decision.phase).toBe('connecting');
    expect(decision.clearLastError).toBe(true);
    expect(decision.notifyGatewayDown).toBe(false);
  });

  test('reconnecting keeps the last error visible and requests the down notice', () => {
    // 'reconnecting' is reported immediately after onError — clearing the error
    // here would wipe the reason before the user ever saw it.
    const decision = decideConnectionPhase('connected', 'reconnecting');
    expect(decision.phase).toBe('connecting');
    expect(decision.clearLastError).toBe(false);
    expect(decision.notifyGatewayDown).toBe(true);
  });

  test('disconnected from connecting or connected becomes failed and schedules a retry', () => {
    expect(decideConnectionPhase('connecting', 'disconnected').phase).toBe('failed');
    expect(decideConnectionPhase('connected', 'disconnected').phase).toBe('failed');
    expect(decideConnectionPhase('connected', 'disconnected').scheduleAutoRetry).toBe(true);
  });

  test('disconnected from an unrelated phase leaves that phase alone', () => {
    // e.g. onboarding/idle/searching are not mid-connection — a disconnect
    // event here is not this attempt failing.
    expect(decideConnectionPhase('idle', 'disconnected').phase).toBe('idle');
    expect(decideConnectionPhase('onboarding', 'disconnected').phase).toBe('onboarding');
  });

  test('disconnected still schedules a retry regardless of starting phase', () => {
    expect(decideConnectionPhase('idle', 'disconnected').scheduleAutoRetry).toBe(true);
  });

  test('pairing does not drive a phase transition here', () => {
    // Pairing is handled by a separate onPairingRequired callback; the status
    // channel reporting it should not fight that state.
    const decision = decideConnectionPhase('pairing', 'pairing');
    expect(decision.phase).toBe('pairing');
    expect(decision.scheduleAutoRetry).toBe(false);
    expect(decision.notifyGatewayDown).toBe(false);
  });
});
