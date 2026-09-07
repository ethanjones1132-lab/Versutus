declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(rel: string[]): string {
  return nodeFs.readFileSync([__dirname, '..', ...rel].join(SEP), 'utf8').replace(/\r\n/g, '\n');
}

function readButton(): string {
  return readSource(['src', 'components', 'ui', 'Button.tsx']);
}

function readTypes(): string {
  return readSource(['src', 'components', 'ui', 'types.ts']);
}

function readPane(file: string): string {
  return readSource(['src', 'components', 'chat', file]);
}

// The four Bot Chat collapsible section toggles (BotChrome, SkillsPane,
// ToolsPane, RoutinesPane) render through `Button` with a real `open`
// boolean driving `{open ? … : null}` content, but `Button` announced only
// `disabled` — so a screen-reader user heard the swapped label with no
// open/closed state while a sighted user saw the section expand. The fix
// adds an optional `expanded` to `ButtonProps`, spreads it into
// `accessibilityState` only when defined, and passes `expanded={open}` on
// the four toggles — matching the `expanded` the sibling PressableScale
// toggles (chat-header, group-room-view) already carry.
describe('pane toggle expanded state', () => {
  test('ButtonProps declares an optional expanded boolean', () => {
    const src = readTypes();
    // Optional so a plain action Button never newly announces `collapsed`.
    expect(src).toMatch(/expanded\?: boolean;/);
  });

  test('Button spreads expanded into accessibilityState only when defined', () => {
    const src = readButton();
    // The defined-only spread keeps the `disabled` half byte-identical and
    // leaves plain Buttons without an `expanded` key entirely.
    expect(src).toContain('...(expanded !== undefined ? { expanded } : null)');
  });

  test('Button still always announces the disabled half', () => {
    const src = readButton();
    expect(src).toContain('accessibilityState={{ disabled: !!isDisabled,');
  });

  test('Button destructures the expanded prop', () => {
    const src = readButton();
    expect(src).toMatch(/accessibilityHint,\n\s+expanded,\n\s+busy,\n\s+selected,\n\}: ButtonProps\)/);
  });

  test('BotChrome passes expanded={open} on its toggle', () => {
    const src = readPane('bot-chrome.tsx');
    expect(src).toContain('expanded={open}');
  });

  test('SkillsPane passes expanded={open} on its toggle', () => {
    const src = readPane('skills-pane.tsx');
    expect(src).toContain('expanded={open}');
  });

  test('ToolsPane passes expanded={open} on its toggle', () => {
    const src = readPane('tools-pane.tsx');
    expect(src).toContain('expanded={open}');
  });

  test('RoutinesPane passes expanded={open} on its toggle', () => {
    const src = readPane('routines-pane.tsx');
    expect(src).toContain('expanded={open}');
  });

  test('each pane wires expanded exactly once, on the toggle — not the Retry button', () => {
    // The Retry buttons inside the panes are pure actions and correctly
    // stateless; the single `expanded={open}` per file is the toggle.
    for (const file of ['skills-pane.tsx', 'tools-pane.tsx', 'routines-pane.tsx', 'bot-chrome.tsx']) {
      const src = readPane(file);
      expect(src.match(/expanded=\{open\}/g)?.length ?? 0).toBe(1);
    }
  });

  test('the four toggle label calls stay byte-identical', () => {
    expect(readPane('bot-chrome.tsx')).toContain('label={botChromeToggleLabel(open)}');
    expect(readPane('skills-pane.tsx')).toContain('label={skillsToggleLabel(state, open)}');
    expect(readPane('tools-pane.tsx')).toContain('label={toolsetsToggleLabel(state, open)}');
    expect(readPane('routines-pane.tsx')).toContain('label={routinesToggleLabel(state, open)}');
  });

  test('the four toggles keep variant, size, and the flip handler byte-identical', () => {
    const chrome = readPane('bot-chrome.tsx');
    expect(chrome).toContain('variant="ghost"');
    expect(chrome).toContain('size="sm"');
    for (const file of ['bot-chrome.tsx', 'skills-pane.tsx', 'tools-pane.tsx', 'routines-pane.tsx']) {
      expect(readPane(file)).toContain('onPress={() => setOpen((value) => !value)}');
    }
  });

  test('Button.ios.tsx stays untouched with no expanded half', () => {
    const src = readSource(['src', 'components', 'ui', 'Button.ios.tsx']);
    expect(src).not.toContain('expanded');
  });
});
