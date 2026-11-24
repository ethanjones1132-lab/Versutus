/**
 * Route test for the migrated capability screen.
 *
 * The screen used to carry two titles: the native modal header's "Capabilities"
 * and a second `<Text variant="title">` in the scroll body. One component now
 * owns the title area — the tree renders exactly one heading, drawn by
 * `AppHeader`, and the Stack no longer asks for a native header on that route.
 */

jest.mock('expo-router', () => ({
  useRouter: () => ({ back: jest.fn(), canGoBack: () => false, replace: jest.fn() }),
}));

jest.mock('@/components/gateway/capabilities-section', () => ({ CapabilitiesSection: 'CapabilitiesSection' }));
jest.mock('@/components/gateway/toolsets-section', () => ({ ToolsetsSection: 'ToolsetsSection' }));
jest.mock('@/components/gateway/rpc-methods-section', () => ({ RpcMethodsSection: 'RpcMethodsSection' }));

// The header is real: this test asserts the rendered tree, not a snapshot of
// a mock standing in for it. The rest of the UI surface is stubbed so the
// route can mount without the whole component barrel's native deps.
jest.mock('@/components/ui', () => {
  const actualHeader = jest.requireActual('@/components/ui/AppHeader') as typeof import('@/components/ui/AppHeader');
  const actualText = jest.requireActual('@/components/ui/Text') as typeof import('@/components/ui/Text');
  return {
    AppHeader: actualHeader.AppHeader,
    Text: actualText.Text,
    Screen: 'Screen',
    Icon: 'Icon',
    PressableScale: 'PressableScale',
  };
});
jest.mock('@/components/layout/AmbientCanvas', () => ({ AmbientCanvas: 'AmbientCanvas' }));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: 'SafeAreaView',
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

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
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import CapabilityEditorScreen from '@/app/gateway/capabilities';
import { AppHeader } from '@/components/ui';

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as { readFileSync(path: string, encoding: string): string };

function readSource(...parts: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

function stackBlock(layout: string, name: string): string {
  const start = layout.indexOf(`name="${name}"`);
  expect(start).toBeGreaterThanOrEqual(0);
  return layout.slice(start, layout.indexOf('/>', start));
}

describe('the capability route has one title, drawn by AppHeader', () => {
  let renderer: ReactTestRenderer;
  afterEach(async () => {
    if (renderer) await act(async () => renderer.unmount());
  });

  test('the rendered tree mounts AppHeader for the title', async () => {
    await act(async () => {
      renderer = create(createElement(CapabilityEditorScreen));
    });

    const headers = renderer.root.findAllByType(AppHeader);
    expect(headers).toHaveLength(1);
    expect(headers[0].props.variant).toBe('compact');
    expect(headers[0].props.title).toBe('Capabilities');
  });

  test('the title appears once, as the header, with no second title Text', async () => {
    await act(async () => {
      renderer = create(createElement(CapabilityEditorScreen));
    });
    const titleTexts = renderer.root.findAll(
      (node) =>
        ['display', 'title', 'headline'].includes(node.props.variant) &&
        node.props.children === 'Capabilities',
    );
    expect(titleTexts).toHaveLength(1);
    expect(titleTexts[0].props.variant).toBe('headline');
  });

  test('the Stack no longer adds a second native header or title for the route', () => {
    const layout = readSource('src', 'app', '_layout.tsx');
    for (const route of ['gateway/capabilities', 'gateway/setup']) {
      const block = stackBlock(layout, route);
      expect(block).toContain('headerShown: false');
      expect(block).not.toContain('headerShown: true');
      expect(block).not.toContain('title:');
      expect(block).not.toContain('headerStyle');
    }
  });
});
