declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
  existsSync(path: string): boolean;
};

function readSource(rel: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...rel].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

const exists = (rel: string[]) =>
  nodeFs.existsSync([__dirname, '..', ...rel].join(SEP));

/**
 * Structural end-state for S6: zero bottom tabs, side drawer owns IA,
 * Chat header opens the drawer on the roster, and Screen owns the bottom
 * safe-area edge now that NativeTabs is gone.
 */
describe('S6 side drawer structural end-state', () => {
  test('drawer content + menu button modules exist', () => {
    expect(exists(['src', 'components', 'nav', 'side-drawer-content.tsx'])).toBe(true);
    expect(exists(['src', 'components', 'nav', 'drawer-menu-button.tsx'])).toBe(true);
  });

  test('Chat roster opens the drawer; threads keep back-to-roster', () => {
    const header = readSource(['src', 'components', 'chat', 'chat-header.tsx']);
    expect(header).toContain('onMenuPress');
    expect(header).toContain('Open navigation menu');
    expect(header).toContain('Back to roster');

    const screen = readSource(['src', 'components', 'chat', 'chat-screen.tsx']);
    expect(screen).toContain("type: 'OPEN_DRAWER'");
    expect(screen).toContain("surface.kind === 'roster'");
  });

  test('Activity, Tools, and Gate mount a drawer menu control', () => {
    expect(readSource(['src', 'app', '(tabs)', 'activity.tsx'])).toContain('DrawerMenuButton');
    expect(readSource(['src', 'components', 'terminal', 'terminal-screen.tsx'])).toContain(
      'DrawerMenuButton',
    );
    expect(readSource(['src', 'app', '(tabs)', 'home.tsx'])).toContain('DrawerMenuButton');
  });

  test('top-level screens take the bottom safe-area edge (hasDock: true)', () => {
    for (const rel of [
      ['src', 'components', 'chat', 'chat-screen.tsx'],
      ['src', 'components', 'terminal', 'terminal-screen.tsx'],
      ['src', 'app', '(tabs)', 'activity.tsx'],
      ['src', 'app', '(tabs)', 'home.tsx'],
    ]) {
      const src = readSource(rel);
      expect(src).toMatch(/hasDock:\s*true/);
      expect(src).not.toMatch(/hasDock:\s*false/);
    }
  });
});
