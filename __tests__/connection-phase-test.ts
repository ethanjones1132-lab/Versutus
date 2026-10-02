import { applyGatewayDownDecision, decideConnectionPhase } from '@/lib/connection/phase';

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

describe('applyGatewayDownDecision', () => {
  test('a gateway that drops posts one notice, and a repeat of the same outage posts none', () => {
    const first = applyGatewayDownDecision(new Set(), decideConnectionPhase('connected', 'reconnecting'), 'gw-a');
    expect(first.notify).toBe(true);
    expect([...first.notifiedGatewayIds]).toEqual(['gw-a']);

    // Another `reconnecting` for the still-down gateway must not stack a second
    // notice on the one already in the tray.
    const second = applyGatewayDownDecision(
      first.notifiedGatewayIds,
      decideConnectionPhase('connecting', 'reconnecting'),
      'gw-a',
    );
    expect(second.notify).toBe(false);
    expect([...second.notifiedGatewayIds]).toEqual(['gw-a']);
  });

  test('another gateway connecting clears only its own outage, never a sibling\'s', () => {
    // A dropped and posted; the operator switches to B, which connects.
    const afterA = applyGatewayDownDecision(new Set(), decideConnectionPhase('connected', 'reconnecting'), 'gw-a');
    const afterB = applyGatewayDownDecision(
      afterA.notifiedGatewayIds,
      decideConnectionPhase('connected', 'connected'),
      'gw-b',
    );

    // B's connect clears B (which had none), and A is still marked down — so the
    // next A outage posts nothing and A's first notice is never duplicated by a
    // sibling's recovery.
    expect([...afterB.notifiedGatewayIds]).toEqual(['gw-a']);
    const aAgain = applyGatewayDownDecision(
      afterB.notifiedGatewayIds,
      decideConnectionPhase('connecting', 'reconnecting'),
      'gw-a',
    );
    expect(aAgain.notify).toBe(false);
  });

  test('A reconnecting again after it actually answered posts a fresh notice', () => {
    // A posts, A connects (its notice retires and its outage is forgotten), then
    // A drops again: this is a new outage and deserves its own notice.
    const posted = applyGatewayDownDecision(new Set(), decideConnectionPhase('connected', 'reconnecting'), 'gw-a');
    const recovered = applyGatewayDownDecision(
      posted.notifiedGatewayIds,
      decideConnectionPhase('connecting', 'connected'),
      'gw-a',
    );
    expect([...recovered.notifiedGatewayIds]).toEqual([]);

    const secondOutage = applyGatewayDownDecision(
      recovered.notifiedGatewayIds,
      decideConnectionPhase('connected', 'reconnecting'),
      'gw-a',
    );
    expect(secondOutage.notify).toBe(true);
  });
});
