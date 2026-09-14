// ─── Push notification preferences (Solution A6 / A8) ──────────────────────
// The preferences fold behind the settings pane. The Gate's
// `notifications.preferences.get/set` (gate/core/push-rpc.mjs) is live and the
// notifier enforces every field, but until this module nothing app-side read
// or wrote them — `enabled` defaulted false and nothing could move it.
//
// Every rule here is pure: a defaults read answers the Gate's own defaults
// (`enabled` off, rich bodies off) rather than inventing any, a patch is built
// from exactly the fields the operator toggled (absent fields are NEVER sent,
// so a pane for one toggle cannot reset the rest), and a failed call answers a
// named failure, never a silent paint of a state that did not land.

import {
  loadPushPreferences,
  pushPreferencesAdvertised,
  setPushPreferences,
  type PushPreferences,
} from '@/lib/notifications/push-preferences';

/** The `client.rpcRequest` seam the preferences functions take. */
function rpcStub(): { rpcRequest: jest.Mock } {
  return { rpcRequest: jest.fn().mockResolvedValue({}) };
}

const GATE_DEFAULTS: PushPreferences = {
  enabled: false,
  richBody: false,
  botIds: [],
  quietHours: null,
};

describe('pushPreferencesAdvertised', () => {
  test('true when the manifest advertises both preferences methods', () => {
    expect(
      pushPreferencesAdvertised(['notifications.preferences.get', 'notifications.preferences.set']),
    ).toBe(true);
  });

  test('false when either method is missing, or the table is unknown or malformed', () => {
    expect(pushPreferencesAdvertised(['notifications.preferences.get'])).toBe(false);
    expect(pushPreferencesAdvertised(['notifications.preferences.set'])).toBe(false);
    expect(pushPreferencesAdvertised(undefined)).toBe(false);
    expect(pushPreferencesAdvertised('nope' as unknown as string[])).toBe(false);
    expect(pushPreferencesAdvertised([42])).toBe(false);
  });
});

describe('loadPushPreferences', () => {
  test('reads through the get method and normalizes the Gate defaults', async () => {
    const rpc = rpcStub();
    rpc.rpcRequest.mockResolvedValue({ ...GATE_DEFAULTS });

    await expect(loadPushPreferences(rpc)).resolves.toEqual({
      ok: true,
      preferences: GATE_DEFAULTS,
    });
    expect(rpc.rpcRequest).toHaveBeenCalledWith('notifications.preferences.get', {});
  });

  test('a row missing fields is filled from the documented defaults, never guessed', async () => {
    const rpc = rpcStub();
    rpc.rpcRequest.mockResolvedValue({ enabled: true });

    await expect(loadPushPreferences(rpc)).resolves.toEqual({
      ok: true,
      preferences: {
        enabled: true,
        richBody: false,
        botIds: [],
        quietHours: null,
      },
    });
  });

  test('non-boolean answers collapse to off rather than a truthy lie', async () => {
    const rpc = rpcStub();
    rpc.rpcRequest.mockResolvedValue({ enabled: 'yes', richBody: 1 });

    await expect(loadPushPreferences(rpc)).resolves.toEqual({
      ok: true,
      preferences: GATE_DEFAULTS,
    });
  });

  test('a failed read answers the failure state, not fabricated preferences', async () => {
    const rpc = rpcStub();
    rpc.rpcRequest.mockRejectedValue(new Error('gate refused'));

    const result = await loadPushPreferences(rpc);
    expect(result.ok).toBe(false);
  });
});

describe('setPushPreferences', () => {
  test('sends only the fields changed, so one toggle cannot reset the rest', async () => {
    const rpc = rpcStub();
    rpc.rpcRequest.mockResolvedValue({ ...GATE_DEFAULTS, enabled: true });

    const result = await setPushPreferences(rpc, { enabled: true });

    expect(result.ok).toBe(true);
    expect(rpc.rpcRequest).toHaveBeenCalledWith('notifications.preferences.set', { enabled: true });
  });

  test('the answer read back is the state now in force', async () => {
    const rpc = rpcStub();
    rpc.rpcRequest.mockImplementation(async (method: string) =>
      method === 'notifications.preferences.get'
        ? { ...GATE_DEFAULTS, richBody: true }
        : ({}),
    );

    const result = await setPushPreferences(rpc, { richBody: true });

    expect(result.ok).toBe(true);
    expect((result as { ok: true; preferences: PushPreferences }).preferences.richBody).toBe(true);
  });

  test('a refused patch is a named failure the pane can show without painting a lie', async () => {
    const rpc = rpcStub();
    rpc.rpcRequest.mockRejectedValue(new Error('bad quietHours'));

    const result = await setPushPreferences(rpc, { enabled: true });

    expect(result.ok).toBe(false);
  });
});
