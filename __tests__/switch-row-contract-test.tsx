/**
 * Contract tests for the shared `SwitchRow`.
 *
 * The row is the one place a setting's switch is built, so these tests pin what
 * a screen may rely on: the visible title/body and the same title as the
 * accessibility label, a controlled `value` that only changes when the caller
 * passes a new one, `onValueChange` receiving the requested value, `disabled`
 * locking the switch, `loading` showing a placeholder instead of a live switch,
 * and the off-track colour that cleared 3:1.
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

import { createElement } from 'react';
import { Switch } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { Palette } from '@/constants/tokens';
import { Skeleton } from '@/components/ui/Skeleton';
import { SwitchRow, type SwitchRowProps } from '@/components/ui/SwitchRow';

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as { readFileSync(path: string, encoding: string): string };

function readSource(...parts: string[]): string {
  return nodeFs.readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8');
}

function mount(props: SwitchRowProps): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(createElement(SwitchRow, props));
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

describe('SwitchRow contract', () => {
  test('declares a required controlled value and change handler', () => {
    const source = readSource('src', 'components', 'ui', 'SwitchRow.tsx');
    expect(source).toMatch(/title: string;/);
    expect(source).toMatch(/value: boolean;/);
    expect(source).toMatch(/onValueChange: \(value: boolean\) => void;/);
    expect(source).not.toMatch(/value\?:/);
    expect(source).not.toMatch(/onValueChange\?:/);
    expect(source).toContain('value={value}');
    expect(source).not.toContain('defaultValue');

    const index = readSource('src', 'components', 'ui', 'index.ts');
    expect(index).toContain("export { SwitchRow } from './SwitchRow';");
    expect(index).toContain("export type { SwitchRowProps } from './SwitchRow';");
  });

  test('draws its title and optional body, and announces the title as its label', () => {
    const renderer = mount({
      title: 'Push notifications',
      body: 'Runs and approvals arrive here.',
      value: false,
      onValueChange: () => undefined,
    });

    expect(textOf(renderer)).toContain('Push notifications');
    expect(textOf(renderer)).toContain('Runs and approvals arrive here.');

    const toggle = renderer.root.findByType(Switch);
    expect(toggle.props.accessibilityLabel).toBe('Push notifications');
    expect(toggle.props.accessibilityState.checked).toBe(false);
  });

  test('is controlled: the caller owns value and onValueChange reports the request', () => {
    const onValueChange = jest.fn();
    const renderer = mount({ title: 'Push notifications', value: false, onValueChange });

    const toggle = renderer.root.findByType(Switch);
    expect(toggle.props.value).toBe(false);

    act(() => toggle.props.onValueChange(true));
    expect(onValueChange).toHaveBeenCalledWith(true);
    // No internal copy: the switch still reads the prop the caller passed.
    expect(renderer.root.findByType(Switch).props.value).toBe(false);

    act(() => {
      renderer.update(createElement(SwitchRow, { title: 'Push notifications', value: true, onValueChange }));
    });
    expect(renderer.root.findByType(Switch).props.value).toBe(true);
    expect(renderer.root.findByType(Switch).props.accessibilityState.checked).toBe(true);
  });

  test('disabled locks the switch and says so to a screen reader', () => {
    const renderer = mount({
      title: 'Push notifications',
      value: true,
      onValueChange: () => undefined,
      disabled: true,
    });

    const toggle = renderer.root.findByType(Switch);
    expect(toggle.props.disabled).toBe(true);
    expect(toggle.props.accessibilityState.disabled).toBe(true);
  });

  test('loading shows a placeholder in place of the switch, never a live control', () => {
    const renderer = mount({
      title: 'Push notifications',
      value: false,
      onValueChange: () => undefined,
      loading: true,
    });

    expect(renderer.root.findAllByType(Switch)).toHaveLength(0);
    expect(renderer.root.findAllByType(Skeleton)).toHaveLength(1);

    const announced = renderer.root.findAll(
      (node) => node.props.accessibilityLabel === 'Push notifications is loading',
    );
    expect(announced.length).toBeGreaterThan(0);
  });

  test('keeps the off track that clears 3:1 and the shared thumb colour', () => {
    const renderer = mount({ title: 'Push notifications', value: false, onValueChange: () => undefined });
    const toggle = renderer.root.findByType(Switch);
    expect(toggle.props.trackColor).toEqual({ true: Palette.accent, false: Palette.controlTrackOff });
    expect(toggle.props.thumbColor).toBe(Palette.textPrimary);
  });
});
