import {
  setPushPreferences,
  pushPreferencesPatch,
} from '@/lib/notifications/push-preferences';

/** The `client.rpcRequest` seam `setPushPreferences` takes. */
function rpcStub(): { rpcRequest: jest.Mock } {
  return { rpcRequest: jest.fn().mockResolvedValue({}) };
}

describe('the quiet-hours pane rides the same patch fold, never a bespoke one', () => {
  test('a quietHours patch sends exactly the window and nothing else', async () => {
    const rpc = rpcStub();
    rpc.rpcRequest.mockResolvedValue({ quietHours: { startMinutes: 1320, endMinutes: 420 } });

    const result = await setPushPreferences(rpc, {
      quietHours: { startMinutes: 22 * 60, endMinutes: 7 * 60 },
    });

    expect(result.ok).toBe(true);
    expect(rpc.rpcRequest).toHaveBeenCalledWith(
      'notifications.preferences.set',
      { quietHours: { startMinutes: 1320, endMinutes: 420 } },
    );
    expect(
      (result as { ok: true; preferences: { quietHours: { startMinutes: number; endMinutes: number } | null } })
        .preferences.quietHours,
    ).toEqual({ startMinutes: 1320, endMinutes: 420 });
  });

  test('clearing quiet hours sends null — "no window" — never an omission that means leave-as-is', async () => {
    const rpc = rpcStub();
    rpc.rpcRequest.mockResolvedValue({ quietHours: null });

    await setPushPreferences(rpc, { quietHours: null });

    expect(rpc.rpcRequest).toHaveBeenCalledWith(
      'notifications.preferences.set',
      { quietHours: null },
    );
  });

  test('a quietHours patch never carries enabled, richBody or botIds', () => {
    const patch = pushPreferencesPatch({ quietHours: { startMinutes: 0, endMinutes: 60 } });
    expect(patch).toEqual({ quietHours: { startMinutes: 0, endMinutes: 60 } });
    expect(patch).not.toHaveProperty('enabled');
    expect(patch).not.toHaveProperty('richBody');
    expect(patch).not.toHaveProperty('botIds');
  });
});
