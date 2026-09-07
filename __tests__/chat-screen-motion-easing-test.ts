declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readChatScreenSource(): string {
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'components', 'chat', 'chat-screen.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

// The chat screen rendered two transient affordances — the last-error banner
// wrapper (chat-screen.tsx:186) and the jump-to-latest pill (chat-screen.tsx:1502)
// — with `FadeIn.duration(Motion.duration.fast)` directly, so they used Reanimated's
// default easing curve (Easing.bezier(0.193, 0.927, 0.539, 0.869)) instead of the
// `easings.decelerate` curve the `entering.fadeIn` preset at
// src/lib/motion/presets.ts:27 chains onto every other sheet/glass/onboarding
// surface in the app. The error banner and jump pill now both start slow and
// accelerate into view while their siblings start fast and decelerate into view
// — opposite rhythms.
describe('chat-screen FadeIn easing uses the entering.fadeIn preset', () => {
  test('imports `entering` from the motion presets module', () => {
    const src = readChatScreenSource();
    expect(src).toMatch(/import\s*\{\s*entering\s*\}\s*from\s*'@\/lib\/motion\/presets';/);
  });

  test('no longer imports `FadeIn` from react-native-reanimated (it is unused now)', () => {
    const src = readChatScreenSource();
    // The old line `import Animated, { FadeIn } from 'react-native-reanimated';`
    // would re-introduce an unused import that ESLint would flag. The import
    // is now bare `import Animated from 'react-native-reanimated';`.
    expect(src).not.toMatch(/FadeIn/);
  });

  test('the last-error banner wrapper uses `entering.fadeIn.duration(Motion.duration.fast)`', () => {
    const src = readChatScreenSource();
    expect(src).toMatch(
      /<Animated\.View\s+entering=\{entering\.fadeIn\.duration\(Motion\.duration\.fast\)\}\s+style=\{styles\.bannerWrap\}>/,
    );
  });

  test('the jump-to-latest pill uses `entering.fadeIn.duration(Motion.duration.fast)`', () => {
    const src = readChatScreenSource();
    expect(src).toMatch(
      /<Animated\.View\s+entering=\{entering\.fadeIn\.duration\(Motion\.duration\.fast\)\}/,
    );
  });

  test('neither call site still uses the bare `FadeIn.duration(...)` literal', () => {
    const src = readChatScreenSource();
    // The pre-change literal was `FadeIn.duration(Motion.duration.fast)` at two
    // sites; both must be gone now that the preset's easing curve is reused.
    const matches = src.match(/FadeIn\.duration\(/g) ?? [];
    expect(matches.length).toBe(0);
  });

  test('`Motion.duration.fast` is still used so the import is not dead', () => {
    const src = readChatScreenSource();
    // The new shape still chains `Motion.duration.fast`, so the Motion import
    // stays meaningful. Exactly two uses: the banner and the pill.
    const matches = src.match(/Motion\.duration\.fast/g) ?? [];
    expect(matches.length).toBe(2);
  });

  test('`Motion` itself is still imported from `@/constants/tokens`', () => {
    const src = readChatScreenSource();
    expect(src).toMatch(/import\s*\{[^}]*\bMotion\b[^}]*\}\s*from\s*'@\/constants\/tokens';/);
  });
});
