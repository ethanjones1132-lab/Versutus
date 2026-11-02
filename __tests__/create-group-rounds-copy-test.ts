import { describeGroupRoundsCopy } from '@/components/chat/create-group-sheet';
import { GROUP_ROUNDS_ON_SEND } from '@/lib/gateway/groups';

// Importing the sheet evaluates the UI barrel, which reads reanimated at
// module scope. This suite only calls the sheet's pure copy helper, so the
// animation runtime is stubbed exactly as the neighbouring component tests do.
jest.mock('react-native-reanimated', () => {
  const { View, Text, ScrollView, Pressable } = jest.requireActual('react-native');
  const chain = (): unknown => {
    const proxy: unknown = new Proxy(function () {}, {
      get: (_t, key) => (key === 'then' ? undefined : proxy),
      apply: () => proxy,
    });
    return proxy;
  };
  return {
    __esModule: true,
    default: { View, Text, ScrollView, Pressable, createAnimatedComponent: (c: unknown) => c },
    Easing: {
      bezier: () => (v: number) => v,
      elastic: () => (v: number) => v,
      out: (fn: (v: number) => number) => fn,
      inOut: (fn: (v: number) => number) => fn,
      cubic: (v: number) => v,
      ease: (v: number) => v,
    },
    useSharedValue: (value: unknown) => ({ value, get: () => value, set: () => undefined }),
    useAnimatedStyle: () => ({}),
    useAnimatedKeyboard: () => ({ height: { value: 0 } }),
    withTiming: (value: unknown) => value,
    withSpring: (value: unknown) => value,
    withRepeat: (value: unknown) => value,
    runOnJS: (fn: unknown) => fn,
    createAnimatedComponent: (c: unknown) => c,
    FadeIn: { duration: chain, easing: chain, delay: chain },
    FadeOut: { duration: chain, easing: chain, delay: chain },
    FadeInDown: { duration: chain, easing: chain, delay: chain },
  };
});

// This suite calls only the sheet's pure copy helper, never renders it, so the
// UI barrel (which pulls Skia and more native modules) is stubbed too.
jest.mock('@/components/ui', () => ({
  BaseSheet: 'BaseSheet',
  Button: 'Button',
  Chip: 'Chip',
  Text: 'Text',
  TextField: 'TextField',
}));

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSheetSource(): string {
  // The component is CRLF on disk; normalize so the assertions below do not
  // depend on the checkout's line endings.
  return nodeFs
    .readFileSync([__dirname, '..', 'src', 'components', 'chat', 'create-group-sheet.tsx'].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

const COPY_PREFIX = 'One message runs a round-robin: every member replies in turn,';

// The sheet used to say "up to 3 rounds" while a phone send runs
// GROUP_ROUNDS_ON_SEND (one round), so the promise and the wire disagreed
// (QUALITY-SCAN 2026-10-11 group_rounds_copy). The copy now reads the same
// constant the send path reads; these tests fail if a literal comes back or
// if the sentence stops tracking the count.
describe('create-group rounds copy', () => {
  test('the default promise is the count a phone send actually runs', () => {
    expect(GROUP_ROUNDS_ON_SEND).toBe(1);
    expect(describeGroupRoundsCopy()).toBe(`${COPY_PREFIX} up to 1 round.`);
  });

  test('the old three-round promise is gone', () => {
    expect(describeGroupRoundsCopy()).not.toContain('3 rounds');
    expect(describeGroupRoundsCopy()).not.toContain('three rounds');
  });

  test('the sheet carries no hand-copied round count', () => {
    const src = readSheetSource();
    expect(src).not.toContain('up to 3 rounds');
    expect(src).not.toMatch(/up to \d+ rounds?/);
  });

  test('the sheet renders the derived line, not a literal', () => {
    const src = readSheetSource();
    expect(src).toContain('{describeGroupRoundsCopy()}');
    expect(src).toContain("from '@/lib/gateway/groups'");
    expect(src).toMatch(/GROUP_ROUNDS_ON_SEND/);
  });

  test('the copy follows the count it is given, singular and plural', () => {
    expect(describeGroupRoundsCopy(1)).toBe(`${COPY_PREFIX} up to 1 round.`);
    expect(describeGroupRoundsCopy(2)).toBe(`${COPY_PREFIX} up to 2 rounds.`);
    expect(describeGroupRoundsCopy(5)).toBe(`${COPY_PREFIX} up to 5 rounds.`);
  });

  test('the wording around the number is unchanged', () => {
    // Only the round count is derived; the sentence keeps its existing words.
    expect(describeGroupRoundsCopy().startsWith(COPY_PREFIX)).toBe(true);
    expect(describeGroupRoundsCopy().endsWith('round.')).toBe(true);
  });
});
