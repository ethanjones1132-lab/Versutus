import { gatewayHandshake } from '@/lib/fleet/gateway-handshake';

describe('the saved-gateway handshake', () => {
  test('the already-live gateway is never re-connected and stays quiet', () => {
    const state = gatewayHandshake({
      gatewayName: 'Home',
      gatewayId: 'gw-home',
      connectedGatewayId: 'gw-home',
      status: 'connected',
    });
    expect(state.canConnect).toBe(false);
    expect(state.statusLine).toBeNull();
  });

  test('this gateway\u2019s handshake in flight names it and blocks a second one', () => {
    for (const [status, expected] of [
      ['connecting', 'Connecting to Home…'],
      ['reconnecting', 'Reconnecting to Home…'],
      ['pairing', 'Needs approval — approve the pairing request on Home'],
    ] as const) {
      const state = gatewayHandshake({
        gatewayName: 'Home',
        gatewayId: 'gw-home',
        connectedGatewayId: null,
        activeGatewayId: 'gw-home',
        status,
      });
      expect(state.canConnect).toBe(false);
      expect(state.statusLine).toBe(expected);
    }
  });

  test('no second handshake starts while another gateway owns the connection attempt', () => {
    const state = gatewayHandshake({
      gatewayName: 'Travel',
      gatewayId: 'gw-travel',
      connectedGatewayId: null,
      activeGatewayId: 'gw-home',
      activeGatewayName: 'Home',
      status: 'connecting',
    });
    expect(state.canConnect).toBe(false);
    expect(state.statusLine).toBe('Connecting to Home…');
  });

  test('a failed handshake names the reason and lets the operator retry', () => {
    const state = gatewayHandshake({
      gatewayName: 'Travel',
      gatewayId: 'gw-travel',
      connectedGatewayId: null,
      activeGatewayId: null,
      status: 'disconnected',
      failureReason: 'Cannot reach 100.64.0.3:8760 — request timed out',
    });
    expect(state.canConnect).toBe(true);
    expect(state.statusLine).toBe('Cannot reach 100.64.0.3:8760 — request timed out');
  });

  test('a quiet idle gateway is connectable and says nothing', () => {
    const state = gatewayHandshake({
      gatewayName: 'Travel',
      gatewayId: 'gw-travel',
      connectedGatewayId: 'gw-home',
      status: 'connected',
    });
    expect(state.canConnect).toBe(true);
    expect(state.statusLine).toBeNull();
  });
});
