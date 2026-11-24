/**
 * Contract tests for the shared `AppHeader`.
 *
 * The app's one header owns the title area, so these tests pin what a screen
 * may rely on: the `page`, `thread` and `compact` shapes, the flat-at-rest /
 * surfaced-when-scrolled rule (including the trip back to the top), the
 * accessible heading role, and the fact that an empty or hidden title draws
 * nothing at all instead of a stray line.
 */

jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  const createAnimatedComponent = (component: unknown) => component;
  return {
    __esModule: true,
    default: { View, createAnimatedComponent },
    createAnimatedComponent,
    useSharedValue: (value: unknown) => ({ value }),
    useAnimatedStyle: () => ({}),
    withTiming: (value: unknown) => value,
    withRepeat: (value: unknown) => value,
    Easing: {
      bezier: () => (value: number) => value,
      elastic: () => (value: number) => value,
      ease: (value: number) => value,
      linear: (value: number) => value,
      in: (fn: (value: number) => number) => fn,
      out: (fn: (value: number) => number) => fn,
      inOut: (fn: (value: number) => number) => fn,
    },
  };
});

jest.mock('@/lib/motion/hooks', () => ({
  usePressScale: () => ({ animatedStyle: {}, onPressIn: () => undefined, onPressOut: () => undefined }),
}));

jest.mock('expo-symbols', () => ({ SymbolView: 'SymbolView' }));

jest.mock('expo-glass-effect', () => ({ GlassView: 'GlassView' }));

import { createElement } from 'react';
import { ScrollView, StyleSheet, Text as RNText, View } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { Palette } from '@/constants/tokens';
import { AppHeader, type AppHeaderProps } from '@/components/ui/AppHeader';
import { useHeaderScrolled } from '@/hooks/use-header-scrolled';

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as { readFileSync(path: string, encoding: string): string };

function readSource(...parts: string[]): string {
  return nodeFs.readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8');
}

function mount(props: AppHeaderProps): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(createElement(AppHeader, props));
  });
  return renderer;
}

function textOf(renderer: ReactTestRenderer): string {
  return renderer.root
    .findAll(() => true)
    .flatMap((node) => {
      const { children } = node.props;
      if (typeof children === 'string' || typeof children === 'number') return [String(children)];
      if (Array.isArray(children)) {
        return children.filter((child) => typeof child === 'string' || typeof child === 'number').map(String);
      }
      return [];
    })
    .join('\n');
}

function headerRoles(renderer: ReactTestRenderer) {
  return renderer.root.findAll((node) => node.props.accessibilityRole === 'header');
}

function rootStyle(renderer: ReactTestRenderer, testID: string) {
  const root = renderer.root.findAllByProps({ testID })[0];
  return StyleSheet.flatten(root.props.style) as unknown as {
    backgroundColor?: string;
    borderBottomColor?: string;
  };
}

/** A tiny screen: the header and the scroll view that drives its surface. */
function ScrollingScreen({ title }: { title: string }) {
  const { scrolled, onScroll } = useHeaderScrolled();
  return (
    <View>
      <AppHeader variant="page" title={title} scrolled={scrolled} status={<RNText>Connected</RNText>} />
      <ScrollView testID="scroll" onScroll={onScroll} />
    </View>
  );
}

describe('AppHeader contract', () => {
  test('the three variants are the design table shapes, not aliases', () => {
    const page = mount({ variant: 'page', title: 'Home', status: <RNText>Connected</RNText> });
    expect(page.root.findAllByProps({ testID: 'app-header-page' }).length).toBeGreaterThan(0);
    expect(textOf(page)).toContain('Home');
    expect(textOf(page)).toContain('Connected');

    const thread = mount({ variant: 'thread', title: 'Hermes', subtitle: 'Sonnet · 18k' });
    expect(thread.root.findAllByProps({ testID: 'app-header-thread' }).length).toBeGreaterThan(0);
    expect(textOf(thread)).toContain('Hermes');
    expect(textOf(thread)).toContain('Sonnet · 18k');

    const compact = mount({ variant: 'compact', title: 'Capabilities' });
    expect(compact.root.findAllByProps({ testID: 'app-header-compact' }).length).toBeGreaterThan(0);
    expect(textOf(compact)).toContain('Capabilities');
    expect(compact.root.findAllByProps({ testID: 'app-header-page' })).toHaveLength(0);
  });

  test('a screen may keep its own testID on the header root', () => {
    const renderer = mount({ variant: 'compact', title: 'Capabilities', testID: 'capabilities-header' });
    expect(renderer.root.findAllByProps({ testID: 'capabilities-header' }).length).toBeGreaterThan(0);
  });

  test('the title is announced as a heading, and its controls stay separate elements', () => {
    const renderer = mount({
      variant: 'page',
      title: 'Activity',
      leading: createElement(RNText, { accessibilityLabel: 'Open navigation menu' }, 'menu'),
      trailing: createElement(RNText, { accessibilityLabel: 'Open settings' }, 'settings'),
    });
    expect(headerRoles(renderer).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Open navigation menu' }).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Open settings' }).length).toBeGreaterThan(0);
  });

  test('flat at rest, smoked glass only while content is under it — and back at the top', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(createElement(ScrollingScreen, { title: 'Home' }));
    });

    expect(rootStyle(renderer, 'app-header-page').backgroundColor).toBeUndefined();
    expect(rootStyle(renderer, 'app-header-page').borderBottomColor).toBe('transparent');

    act(() => {
      renderer.root
        .findAllByProps({ testID: 'scroll' })[0]
        .props.onScroll({ nativeEvent: { contentOffset: { y: 40 } } });
    });

    expect(rootStyle(renderer, 'app-header-page').backgroundColor).toBe(Palette.stageGlass);
    expect(rootStyle(renderer, 'app-header-page').borderBottomColor).toBe(Palette.border);

    act(() => {
      renderer.root
        .findAllByProps({ testID: 'scroll' })[0]
        .props.onScroll({ nativeEvent: { contentOffset: { y: 0 } } });
    });

    expect(rootStyle(renderer, 'app-header-page').backgroundColor).toBeUndefined();
  });

  test('an empty or whitespace title draws no stray heading', () => {
    for (const title of ['', '   ']) {
      const renderer = mount({ variant: 'page', title });
      expect(headerRoles(renderer)).toHaveLength(0);
      expect(textOf(renderer).trim()).toBe('');
    }
  });

  test('titleHidden keeps the bar and its status while omitting the title', () => {
    const renderer = mount({
      variant: 'thread',
      title: 'Hermes',
      titleHidden: true,
      subtitle: 'Connected',
    });
    expect(textOf(renderer)).not.toContain('Hermes');
    expect(textOf(renderer)).toContain('Connected');
    expect(headerRoles(renderer)).toHaveLength(0);
  });

  test('the component is exported from the ui barrel and reads the shared tokens', () => {
    const index = readSource('src', 'components', 'ui', 'index.ts');
    expect(index).toContain("export { AppHeader } from './AppHeader';");
    const source = readSource('src', 'components', 'ui', 'AppHeader.tsx');
    expect(source).toContain('tokens.stageGlass');
    expect(source).toContain('tokens.border');
    expect(source).not.toMatch(/#[0-9a-f]{3,8}/i);
  });
});
