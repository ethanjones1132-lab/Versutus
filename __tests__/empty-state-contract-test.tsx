/**
 * Contract tests for the shared `EmptyState`.
 *
 * A screen relies on four things: `icon` and `title` are required, the
 * optional description is drawn as written, the action only appears when both
 * `actionLabel` and `onAction` arrive, and that action is a primary button the
 * screen reader announces with the action's own label. Each assertion below
 * fails if the component weakens one of them.
 */

jest.mock('react-native-reanimated', () => {
  const createAnimatedComponent = (component: unknown) => component;
  return {
    __esModule: true,
    default: { createAnimatedComponent },
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

import { Button } from '@/components/ui/Button';
import { EmptyState, type EmptyStateProps } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as { readFileSync(path: string, encoding: string): string };

function readSource(...parts: string[]): string {
  return nodeFs.readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8');
}

const ICON = { ios: 'person.2', android: 'group', web: 'group' } as const;

function mount(props: EmptyStateProps): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(createElement(EmptyState, props));
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

describe('EmptyState contract', () => {
  test('requires an icon and a title', () => {
    const source = readSource('src', 'components', 'ui', 'EmptyState.tsx');
    expect(source).toMatch(/icon: IconName;/);
    expect(source).toMatch(/title: string;/);
    expect(source).not.toMatch(/icon\?:/);
    expect(source).not.toMatch(/title\?:/);

    const renderer = mount({ icon: ICON, title: 'Nothing here yet' });
    expect(renderer.root.findByType(Icon).props.name).toBe(ICON);
    expect(textOf(renderer)).toContain('Nothing here yet');
  });

  test('draws the optional description only when it is supplied', () => {
    const withDescription = mount({
      icon: ICON,
      title: 'Nothing here yet',
      description: 'Items will appear here when they are available.',
    });
    expect(textOf(withDescription)).toContain('Items will appear here when they are available.');

    const withoutDescription = mount({ icon: ICON, title: 'Nothing here yet' });
    expect(textOf(withoutDescription)).not.toContain('Items will appear here when they are available.');
  });

  test('offers no action unless actionLabel and onAction arrive together', () => {
    expect(mount({ icon: ICON, title: 'Nothing here yet' }).root.findAllByType(Button)).toHaveLength(0);

    // The type allows either optional prop on its own, which is exactly why the
    // component and the lint guard must reject a half-named action.
    const labelOnly = mount({
      icon: ICON,
      title: 'Nothing here yet',
      actionLabel: 'Retry',
    });
    expect(labelOnly.root.findAllByType(Button)).toHaveLength(0);

    const handlerOnly = mount({
      icon: ICON,
      title: 'Nothing here yet',
      onAction: () => undefined,
    });
    expect(handlerOnly.root.findAllByType(Button)).toHaveLength(0);
  });

  test('the action is a primary button labelled and announced with actionLabel', () => {
    const onAction = jest.fn();
    const renderer = mount({
      icon: ICON,
      title: 'Nothing here yet',
      actionLabel: 'Retry',
      onAction,
    });

    const [button] = renderer.root.findAllByType(Button);
    expect(button.props.label).toBe('Retry');
    expect(button.props.variant).toBe('primary');
    expect(button.props.size).toBe('sm');

    // The platform Button exposes the spoken label its own way: the shared
    // implementation passes `accessibilityLabel` to its pressable, while the
    // iOS SwiftUI button announces its `label`. Exclude the Button composite
    // itself (asserted above) so a dropped label on the rendered control still
    // fails here.
    const announced = renderer.root.findAll(
      (node) => node.type !== Button
        && (node.props.accessibilityLabel === 'Retry' || node.props.label === 'Retry'),
    );
    expect(announced.length).toBeGreaterThan(0);

    act(() => button.props.onPress());
    expect(onAction).toHaveBeenCalledTimes(1);
  });
});
