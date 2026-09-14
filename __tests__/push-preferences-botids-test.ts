import {
  PUSH_PREFERENCES_DEFAULTS,
  pushPreferencesFromRow,
  pushPreferencesPatch,
  setPushPreferences,
  type PushPreferences,
} from '@/lib/notifications/push-preferences';

/** The `client.rpcRequest` seam `setPushPreferences` takes. */
function rpcStub(): { rpcRequest: jest.Mock } {
  return { rpcRequest: jest.fn().mockResolvedValue({}) };
}

const GATE_DEFAULTS: PushPreferences = {
  enabled: false,
  richBody: false,
  botIds: [],
  quietHours: null,
};

describe('the per-Bot allowlist rides the same fold, never a bespoke one', () => {
  test('a botIds patch sends exactly the toggled ids and nothing else', async () => {
    const rpc = rpcStub();
    rpc.rpcRequest.mockResolvedValue({ ...GATE_DEFAULTS, botIds: ['scout'] });

    const result = await setPushPreferences(rpc, { botIds: ['scout'] });

    expect(result.ok).toBe(true);
    expect(rpc.rpcRequest).toHaveBeenCalledWith(
      'notifications.preferences.set',
      { botIds: ['scout'] },
    );
    expect(
      (result as { ok: true; preferences: PushPreferences }).preferences.botIds,
    ).toEqual(['scout']);
  });

  test('unchecking every Bot sends the empty array — push no Bots — not an omission that means leave-as-is', async () => {
    const rpc = rpcStub();
    rpc.rpcRequest.mockResolvedValue({ ...GATE_DEFAULTS });

    await setPushPreferences(rpc, { botIds: [] });

    expect(rpc.rpcRequest).toHaveBeenCalledWith(
      'notifications.preferences.set',
      { botIds: [] },
    );
  });

  test('a botIds patch never carries an absent enabled, richBody or quietHours', () => {
    const patch = pushPreferencesPatch({ botIds: ['scout', 'quill'] });
    expect(patch).toEqual({ botIds: ['scout', 'quill'] });
    expect(patch).not.toHaveProperty('enabled');
    expect(patch).not.toHaveProperty('richBody');
    expect(patch).not.toHaveProperty('quietHours');
  });

  test('the Gate defaults keep the empty allowlist meaning "all Bots", untranslated', () => {
    expect(PUSH_PREFERENCES_DEFAULTS.botIds).toEqual([]);
  });

  test('a row holding a Bot list folds through whole — no Bot is invented or dropped', () => {
    expect(pushPreferencesFromRow({ botIds: ['scout', 'quill'], enabled: true })).toEqual({
      enabled: true,
      richBody: false,
      botIds: ['scout', 'quill'],
      quietHours: null,
    });
  });

  test('a refused botIds patch answers the failure state, never an optimistic paint', async () => {
    const rpc = rpcStub();
    rpc.rpcRequest.mockRejectedValue(new Error('gate refused'));

    const result = await setPushPreferences(rpc, { botIds: ['scout'] });
    expect(result.ok).toBe(false);
  });
});

describe('the preferences pane reads the paired Bot roster it already has', () => {
  const nodeFs = jest.requireActual('fs') as {
    readFileSync(path: string, encoding: string): string;
  };
  const nodePath = jest.requireActual('path') as { sep: string };

  function readSource(...parts: string[]): string {
    return nodeFs
      .readFileSync([__dirname, '..', ...parts].join(nodePath.sep), 'utf8')
      .replace(/\r\n/g, '\n');
  }

  const source = () => readSource('src', 'components', 'gateway', 'notification-preferences-section.tsx');

  test('the pane pulls its Bot ids from the roster the context already exposes (listBots), not a new fetch surface', () => {
    const src = source();
    expect(src).toContain('listBots');
    expect(src).toMatch(/useGateway\(\)[\s\S]*?listBots/);
  });

  test('the per-Bot switch paints the Gate-held state and dispatches the toggled Bot through the same fold', () => {
    const src = source();
    expect(src).toMatch(/value=\{preferences\.botIds\.includes\(botId\)\}/);
    expect(src).toMatch(/onValueChange=\{\(next\) => handleBotToggle\(botId, next\)\}/);
    expect(src).toMatch(/setPushPreferences\(/);
  });

  test('the existing enabled and richBody switches, and their copy constants, are byte-identical', () => {
    const src = source();
    expect(src).toContain("const PREFERENCES_ENABLED_LABEL = 'Push notifications';");
    expect(src).toContain("const PREFERENCES_RICH_BODY_LABEL = 'Rich message bodies';");
    expect(src).toContain(
      'Let this gateway reach this device when you are away from the screen',
    );
    expect(src).toContain('Include what the reply or result said in the notification itself.');
  });

  test('the read-failed caption stays byte-identical', () => {
    const src = source();
    expect(src).toContain('could not be read. They are off until it answers.');
  });

  test('the roster rows are not duplicated read-failed copy and the roster read failure paints rows-unknown, never guessed', () => {
    const src = source();
    // A failed roster read answers null, not [], so the pane can tell unknown from empty.
    expect(src).toMatch(/\.catch\(\(\) => \{\s*if \(!cancelled\) setBotIds\(null\);/);
    // An empty-but-read roster is the truth, and paints no rows — but the
    // distinction is made on read success, never by collapsing null to [].
    expect(src).toMatch(/botIds !== null && botIds\.length > 0/);
  });
});
