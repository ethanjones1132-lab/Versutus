jest.mock('react-native-reanimated', () => {
  const { View, Text, ScrollView, Pressable } = require('react-native');
  const createAnimatedComponent = (component: unknown) => component;
  const chain = (): unknown => {
    const proxy: unknown = new Proxy(function () {}, {
      get: (_t, key) => (key === 'then' ? undefined : proxy),
      apply: () => proxy,
    });
    return proxy;
  };
  return {
    __esModule: true,
    default: { View, Text, ScrollView, Pressable, createAnimatedComponent },
    Easing: { bezier: () => (v: number) => v, elastic: () => (v: number) => v, out: (fn: (v: number) => number) => fn, inOut: (fn: (v: number) => number) => fn, cubic: (v: number) => v, ease: (v: number) => v },
    useSharedValue: (value: unknown) => ({ value, get: () => value, set: () => undefined }),
    useAnimatedStyle: () => ({}),
    withTiming: (value: unknown, _c?: unknown, cb?: (finished: boolean) => void) => {
      if (typeof cb === 'function') cb(true);
      return value;
    },
    withSpring: (value: unknown) => value,
    withRepeat: (value: unknown) => value,
    runOnJS: (fn: unknown) => fn,
    FadeIn: { duration: chain, easing: chain, delay: chain },
    FadeOut: { duration: chain, easing: chain, delay: chain },
    FadeInDown: { duration: chain, easing: chain, delay: chain },
    createAnimatedComponent,
    View,
    Text,
    ScrollView,
  };
});

jest.mock('@shopify/react-native-skia', () => ({
  Canvas: 'Canvas',
  Fill: 'Fill',
  Shader: 'Shader',
  Skia: {},
  Group: 'Group',
  Circle: 'Circle',
  Path: 'Path',
  LinearGradient: 'LinearGradient',
  SweepGradient: 'SweepGradient',
  useClock: () => 0,
  usePathValue: () => ({ current: null }),
}));
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn(), back: jest.fn() }),
  useFocusEffect: () => undefined,
  useIsFocused: () => true,
  useLocalSearchParams: () => ({}),
  useNavigation: () => ({ setOptions: jest.fn() }),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: unknown }) => children,
}));
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

jest.mock('@/components/ui', () => {
  const React = require('react');
  const { TextInput } = require('react-native');
  const actual = jest.requireActual('@/components/ui');
  return {
    ...actual,
    TextField: (props: Record<string, unknown>) => React.createElement(TextInput, props),
    Skeleton: () => null,
  };
});

jest.mock('expo-haptics', () => ({
  selectionAsync: async () => undefined,
  impactAsync: async () => undefined,
  notificationAsync: async () => undefined,
  ImpactFeedbackStyle: { Light: 'light' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning' },
}));

import { createElement, type ComponentProps, type ElementType } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import type { NewAgentDraft } from '@/components/chat/new-agent-sheet';
import { NewAgentSheet } from '@/components/chat/new-agent-sheet';
import { Button } from '@/components/ui';

const BUTTON = Button as unknown as ElementType;

type SheetProps = ComponentProps<typeof NewAgentSheet>;

const EDIT_INITIAL = { name: 'anvil', description: 'forge replacement parts', modelId: 'grok-4.6', providerId: 'xai' };

/** Stand-in for the chat screen: the sheet stays mounted under the same key. */
function element(props: Partial<SheetProps> & { visible: boolean; onClose: () => void; onSubmit: (draft: NewAgentDraft) => void }) {
  return createElement(NewAgentSheet, props);
}

async function mountSheet(props: SheetProps): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(element(props));
  });
  return renderer;
}

/**
 * Drive a parent-rendered visible flip without changing the element's key, so
 * the component instance lives across true->false->true exactly like the
 * chat screen's sheet does (the Modal is hidden from the parent, not unmounted).
 */
async function renderUpdate(renderer: ReactTestRenderer, props: SheetProps): Promise<void> {
  await act(async () => {
    renderer.update(element(props));
  });
}

function fieldValue(renderer: ReactTestRenderer, placeholder: string): string {
  const field = renderer.root.findByProps({ placeholder });
  return String(field.props.value ?? '');
}

async function type(renderer: ReactTestRenderer, placeholder: string, text: string): Promise<void> {
  const field = renderer.root.findByProps({ placeholder });
  await act(async () => {
    field.props.onChangeText(text);
  });
}

async function pressLabeled(renderer: ReactTestRenderer, label: string): Promise<void> {
  const button = renderer.root.findAllByType(BUTTON).find((node) => node.props.label === label);
  if (!button) throw new Error(`no ${label} button`);
  await act(async () => {
    await button.props.onPress();
  });
}

describe('the still-mounted New Agent sheet resets itself at each reopening', () => {
  test('a successful create reopens empty/default, not prefilled with the last draft', async () => {
    const onClose = jest.fn();
    const onSubmit = jest.fn();
    const closed: SheetProps = { visible: false, onClose, onSubmit };
    const open: SheetProps = { visible: true, onClose, onSubmit };
    const renderer = await mountSheet(closed);
    await renderUpdate(renderer, open);

    await type(renderer, 'researcher', 'scout');
    await type(renderer, 'Reads code and writes findings', 'runs watcher');
    await type(renderer, 'provider/model-id', 'xai/grok');
    await type(renderer, 'provider-id', 'xai');
    await pressLabeled(renderer, 'Create');

    expect(onSubmit).toHaveBeenCalledWith({
      name: 'scout',
      soul: undefined,
      inheritKeys: true,
      description: 'runs watcher',
      modelId: 'xai/grok',
      providerId: 'xai',
    });

    // The create landed; the parent hides the sheet. No unmount: the same key
    // stays in the tree, so the draft would survive into the next open.
    await renderUpdate(renderer, closed);
    await renderUpdate(renderer, open);

    expect(fieldValue(renderer, 'researcher')).toBe('');
    expect(fieldValue(renderer, 'Reads code and writes findings')).toBe('');
    expect(fieldValue(renderer, 'provider/model-id')).toBe('');
    expect(fieldValue(renderer, 'provider-id')).toBe('');

    // Create defaults: the empty-name gate stands — a reopened sheet that
    // still held the draft would enable Create, this one cannot submit empty.
    const createButton = renderer.root.findAllByType(BUTTON).find((node) => node.props.label === 'Create');
    expect(createButton?.props.disabled).toBe(true);
    await act(async () => renderer.unmount());
  });

  test('an edit of the same Bot reopens on the Bot, not on what was typed last time', async () => {
    const onClose = jest.fn();
    const onSubmit = jest.fn();
    const renderer = await mountSheet({ visible: true, onClose, onSubmit, initial: EDIT_INITIAL });

    await type(renderer, 'Reads code and writes findings', 'throwaway typed edit');
    await type(renderer, 'provider/model-id', 'grok-forgotten');

    // Close and reopen the same Bot: same key, component never unmounted.
    await renderUpdate(renderer, { visible: false, onClose, onSubmit, initial: EDIT_INITIAL });
    await renderUpdate(renderer, { visible: true, onClose, onSubmit, initial: EDIT_INITIAL });

    expect(fieldValue(renderer, 'researcher')).toBe('anvil');
    expect(fieldValue(renderer, 'Reads code and writes findings')).toBe(EDIT_INITIAL.description);
    expect(fieldValue(renderer, 'provider/model-id')).toBe(EDIT_INITIAL.modelId);
    expect(fieldValue(renderer, 'provider-id')).toBe(EDIT_INITIAL.providerId);

    // And when the Gate now holds different values for that Bot, reopening
    // reads those, not the previous session's stale draft.
    const latest = { ...EDIT_INITIAL, description: 'now carries the anvil recast', modelId: 'grok-5.1', providerId: 'xai' };
    await renderUpdate(renderer, { visible: false, onClose, onSubmit, initial: latest });
    await renderUpdate(renderer, { visible: true, onClose, onSubmit, initial: latest });

    expect(fieldValue(renderer, 'researcher')).toBe(latest.name);
    expect(fieldValue(renderer, 'Reads code and writes findings')).toBe(latest.description);
    expect(fieldValue(renderer, 'provider/model-id')).toBe(latest.modelId);
    expect(fieldValue(renderer, 'provider-id')).toBe(latest.providerId);
    await act(async () => renderer.unmount());
  });

  test('a refused submission keeps the draft while the sheet stays visible', async () => {
    const onClose = jest.fn();
    const onSubmit = jest.fn();
    const renderer = await mountSheet({ visible: true, onClose, onSubmit });

    await type(renderer, 'researcher', 'scout');
    await type(renderer, 'Reads code and writes findings', 'kept while refused');
    await pressLabeled(renderer, 'Create');
    expect(onSubmit).toHaveBeenCalledTimes(1);

    // The parent refuses and rerenders busy, then names the error. The sheet
    // never hid — its draft must not be wiped by anything in between.
    await renderUpdate(renderer, { visible: true, busy: true, onClose, onSubmit });
    await renderUpdate(renderer, {
      visible: true,
      busy: false,
      error: 'the Gate refused the create',
      onClose,
      onSubmit,
    });

    expect(fieldValue(renderer, 'researcher')).toBe('scout');
    expect(fieldValue(renderer, 'Reads code and writes findings')).toBe('kept while refused');
    renderer.root.findByProps({ children: 'the Gate refused the create' });
    await act(async () => renderer.unmount());
  });

  test('an unrelated catalogue rerender keeps the typed draft', async () => {
    const onClose = jest.fn();
    const onSubmit = jest.fn();
    const withCatalogue: SheetProps = {
      visible: true,
      onClose,
      onSubmit,
      models: [{ id: 'xai/grok', providerId: 'xai', modelId: 'grok', available: true }],
    };
    const renderer = await mountSheet({ visible: true, onClose, onSubmit });

    await type(renderer, 'researcher', 'scout');
    await type(renderer, 'Reads code and writes findings', 'survives the catalogue');

    // The catalogue arriving while the sheet sits open rerenders it; nothing
    // the operator typed may be discarded.
    await renderUpdate(renderer, withCatalogue);

    expect(fieldValue(renderer, 'researcher')).toBe('scout');
    expect(fieldValue(renderer, 'Reads code and writes findings')).toBe('survives the catalogue');
    await act(async () => renderer.unmount());
  });
});
