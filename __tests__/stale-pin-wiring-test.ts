declare const __dirname: string;
const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as { readFileSync(path: string, encoding: string): string };
const provider = nodeFs
  .readFileSync([__dirname, '..', 'src', 'context', 'gateway-provider.tsx'].join(SEP), 'utf8')
  .replace(/\r\n/g, '\n');

describe('a stored pin is repaired wherever it can be judged', () => {
  // 2026-09-16: the repair ran only on connect, when usually no Bot is
  // selected, so a Bot pinned to a provider its Hermes catalogue lacks was
  // never checked and failed every turn.
  test('connect runs the shared repair', () => {
    expect(provider).toContain('void repairStalePinRef.current?.(client, isCurrent, gateway);');
  });

  test('a landed Bot Chat open runs it too, against the Bot catalogue', () => {
    const openBot = provider.slice(provider.indexOf('const openBot = useCallback'));
    const landed = openBot.slice(0, openBot.indexOf('return true;'));
    expect(landed).toContain('repairStalePinRef.current?.(');
  });

  test("only a Bot's catalogue is treated as listing every provider", () => {
    expect(provider).toContain('providersAuthoritative: Boolean(botId)');
    expect(provider).toContain('stalePinNote(stale)');
  });
});
