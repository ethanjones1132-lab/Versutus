import { gatewayScopeKey, scopeForAttach } from '@/lib/gateway/client-scope';

// 2026-10-01: a rebuilt client is a client with no scope. `selectedBackendId`
// and `selectedBotId` live in provider state and survive the rebuild, so the UI
// kept showing the Hermes thread while the new client sent no `backendId`, no
// `bot` and `providerId: 'kilo'` — the Gate's own providers answering for a
// model only Hermes serves. Re-attaching has to hand the scope over, and must
// not hand gateway A's environment over to gateway B's client.

describe('which gateway a scope belongs to', () => {
  test('a profile is keyed by its own id', () => {
    expect(gatewayScopeKey({ id: 'gate-a' })).toBe('gate-a');
  });

  test('a child profile shares its parent\'s key, the way the manifest cache does', () => {
    // The same normalisation saveCachedGateManifest uses: a child profile serves
    // its parent's manifest, so the parent's Gate is the one the scope belongs to.
    expect(gatewayScopeKey({ id: 'gate-a::openai', parentId: 'gate-a' })).toBe('gate-a');
  });

  test('nothing known is no key', () => {
    expect(gatewayScopeKey(undefined)).toBeUndefined();
    expect(gatewayScopeKey(null)).toBeUndefined();
  });
});

describe('the scope a client is installed with', () => {
  test('the same gateway keeps the environment and the Bot', () => {
    expect(
      scopeForAttach({
        attachingGatewayKey: 'gate-a',
        scopeGatewayKey: 'gate-a',
        selectedBackendId: 'hermes-local',
        selectedBotId: 'scout',
      }),
    ).toEqual({ backendId: 'hermes-local', botId: 'scout', reset: false });
  });

  test('the same gateway with an environment but no Bot keeps the environment', () => {
    expect(
      scopeForAttach({
        attachingGatewayKey: 'gate-a',
        scopeGatewayKey: 'gate-a',
        selectedBackendId: 'hermes-local',
        selectedBotId: undefined,
      }),
    ).toEqual({ backendId: 'hermes-local', botId: undefined, reset: false });
  });

  test('a different gateway drops both and reports the reset', () => {
    // The operator switched Gate: `hermes-local` is gateway A's environment and
    // A's Bot, and neither exists on B.
    expect(
      scopeForAttach({
        attachingGatewayKey: 'gate-b',
        scopeGatewayKey: 'gate-a',
        selectedBackendId: 'hermes-local',
        selectedBotId: 'scout',
      }),
    ).toEqual({ backendId: undefined, botId: undefined, reset: true });
  });

  test('a different gateway with no scope to carry applies nothing and does not reset', () => {
    // Not a reset: with nothing remembered, the new gateway's own adoption
    // effect is what picks its default, and a reset would look like a switch.
    expect(
      scopeForAttach({
        attachingGatewayKey: 'gate-b',
        scopeGatewayKey: 'gate-a',
        selectedBackendId: undefined,
        selectedBotId: undefined,
      }),
    ).toEqual({ backendId: undefined, botId: undefined, reset: false });
  });

  test('a Bot with no environment behind it is still a scope to drop', () => {
    expect(
      scopeForAttach({
        attachingGatewayKey: 'gate-b',
        scopeGatewayKey: 'gate-a',
        selectedBackendId: undefined,
        selectedBotId: 'scout',
      }),
    ).toEqual({ backendId: undefined, botId: undefined, reset: true });
  });

  test('no remembered scope on the first attach of a gateway applies nothing', () => {
    expect(
      scopeForAttach({
        attachingGatewayKey: 'gate-a',
        scopeGatewayKey: undefined,
        selectedBackendId: undefined,
        selectedBotId: undefined,
      }),
    ).toEqual({ backendId: undefined, botId: undefined, reset: false });
  });

  test('a scope with no recorded owner is kept, not thrown away on a guess', () => {
    // Dropping a live thread's environment because our own bookkeeping is
    // missing would strand the operator; only a known-foreign scope is dropped.
    expect(
      scopeForAttach({
        attachingGatewayKey: 'gate-b',
        scopeGatewayKey: undefined,
        selectedBackendId: 'hermes-local',
        selectedBotId: undefined,
      }),
    ).toEqual({ backendId: 'hermes-local', botId: undefined, reset: false });
  });

  test('a child profile of the scope\'s own gateway keeps it', () => {
    expect(
      scopeForAttach({
        attachingGatewayKey: 'gate-a',
        scopeGatewayKey: 'gate-a',
        selectedBackendId: 'hermes-local',
        selectedBotId: undefined,
      }),
    ).toEqual({ backendId: 'hermes-local', botId: undefined, reset: false });
  });
});
