declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(rel: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...rel].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

function readBaseSheet(): string {
  return readSource(['src', 'components', 'ui', 'BaseSheet.tsx']);
}

function readGetKeyboardHeight(): string {
  const src = readBaseSheet();
  const match = src.match(/function getKeyboardHeight\(\): number \{[\s\S]*?\n\}/);
  expect(match).not.toBeNull();
  return match![0];
}

// react-native-web's Keyboard has no metrics(); calling it throws and blanks
// every sheet on the browser demo. Guard the snapshot so a missing method
// returns 0, and keep the native metrics()?.height read when it exists.
describe('BaseSheet web keyboard height', () => {
  test('getKeyboardHeight returns 0 when metrics is not a function', () => {
    const fn = readGetKeyboardHeight();
    expect(fn).toContain("typeof Keyboard.metrics !== 'function'");
    expect(fn).toMatch(/typeof Keyboard\.metrics !== 'function'\) return 0/);
  });

  test('getKeyboardHeight still reads Keyboard.metrics()?.height when the method exists', () => {
    const fn = readGetKeyboardHeight();
    expect(fn).toContain('Keyboard.metrics()?.height');
    const guardAt = fn.indexOf("typeof Keyboard.metrics !== 'function'");
    const readAt = fn.indexOf('Keyboard.metrics()?.height');
    expect(guardAt).toBeGreaterThanOrEqual(0);
    expect(readAt).toBeGreaterThan(guardAt);
  });

  test('non-finite height still becomes 0', () => {
    const fn = readGetKeyboardHeight();
    expect(fn).toContain("typeof height === 'number' && Number.isFinite(height) ? height : 0");
  });

  test('the client snapshot is still getKeyboardHeight, not the SSR zero', () => {
    const src = readBaseSheet();
    expect(src).toContain('useSyncExternalStore(');
    expect(src).toContain('subscribeKeyboardHeight,');
    expect(src).toContain('getKeyboardHeight,');
    expect(src).toContain('() => 0,');
  });

  test('a bottom sheet still lifts by IME height from that snapshot', () => {
    const src = readBaseSheet();
    expect(src).toContain("position: 'bottom',");
    expect(src).toContain('inset: insets.bottom,');
    expect(src).toContain('keyboardHeight,');
    expect(src).toContain('sheetAnchoredEdgeMargin({');
  });

  test('lazy mount is untouched', () => {
    const src = readBaseSheet();
    expect(src).toContain('if (!mounted) return null;');
  });

  test('open animation is untouched', () => {
    const src = readBaseSheet();
    expect(src).toContain('translateY.value = withTiming(');
    expect(src).toContain('duration: Motion.duration.normal,');
    expect(src).toContain('easing: Easing.out(Easing.cubic),');
    expect(src).toContain('if (finished && !visible)');
    expect(src).toContain('runOnJS(setMounted)(false)');
  });

  test('ConfirmSheet still renders through BaseSheet', () => {
    const src = readSource(['src', 'components', 'ui', 'ConfirmSheet.tsx']);
    expect(src).toContain("import { BaseSheet } from './BaseSheet'");
    expect(src).toContain('<BaseSheet visible={visible}');
  });
});
