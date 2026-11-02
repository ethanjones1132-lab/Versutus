/**
 * The chat screen keeps the New Agent sheet mounted while the Modal merely
 * hides it (chat-screen.tsx:2620-2630), so a draft could survive a create or an
 * edit and meet the operator again on the next open — name, description, soul,
 * model pin, provider pin, runtime choice and key mode. The sheet now
 * reinitialises itself whenever it is shown again (new-agent-sheet.tsx:111-122,
 * VS-004). This file pins that draft reset, and the parts that must not change:
 * the edit form still prefills from the Bot, a blank description still means
 * "leave untouched", and a refusal (the sheet never hid) keeps what was typed.
 */
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

import type { BotRuntimeOption } from '@/lib/gateway/bot-runtimes';
import type { NewAgentDraft } from '@/components/chat/new-agent-sheet';
import { NewAgentSheet } from '@/components/chat/new-agent-sheet';
import { Button } from '@/components/ui';

const BUTTON = Button as unknown as ElementType;

type SheetProps = ComponentProps<typeof NewAgentSheet>;

const EDIT_INITIAL = {
  name: 'anvil',
  description: 'forge replacement parts',
  modelId: 'grok-4.6',
  providerId: 'xai',
};

const CREATE_PLACEHOLDERS = {
  name: 'researcher',
  description: 'Reads code and writes findings',
  soul: 'Standing personality and instructions',
  modelId: 'provider/model-id',
  providerId: 'provider-id',
};

const EDIT_PLACEHOLDERS = {
  description: 'Reads code and writes findings',
  soul: 'Leave unchanged',
  modelId: 'provider/model-id',
  providerId: 'provider-id',
};

const RUNTIMES: BotRuntimeOption[] = [
  { id: 'hermes-gate', label: 'Hermes', freeOnly: false },
  { id: 'opencode-gate', label: 'OpenCode', freeOnly: false },
];

/** Stand-in for the chat screen: the sheet stays mounted under the same key. */
function element(props: SheetProps) {
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
 * the instance lives across true->false->true exactly like the chat screen's
 * sheet (the Modal is hidden from the parent, not unmounted).
 */
async function renderUpdate(renderer: ReactTestRenderer, props: SheetProps): Promise<void> {
  await act(async () => {
    renderer.update(element(props));
  });
}

/** Hide then show the still-mounted sheet — the round trip after a success. */
async function closeAndReopen(renderer: ReactTestRenderer, props: SheetProps): Promise<void> {
  await renderUpdate(renderer, { ...props, visible: false });
  await renderUpdate(renderer, { ...props, visible: true });
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

function findButton(renderer: ReactTestRenderer, label: string) {
  const button = renderer.root.findAllByType(BUTTON).find((node) => node.props.label === label);
  if (!button) throw new Error(`no ${label} button`);
  return button;
}

async function pressLabeled(renderer: ReactTestRenderer, label: string): Promise<void> {
  const button = findButton(renderer, label);
  await act(async () => {
    await button.props.onPress();
  });
}

function runtimeSelected(renderer: ReactTestRenderer, label: string): boolean {
  return Boolean(renderer.root.findByProps({ accessibilityLabel: `Run on ${label}` }).props.accessibilityState?.selected);
}

/** The "Runs on" chips are Pressables, not Buttons, so they are pressed by label. */
async function pressRuntime(renderer: ReactTestRenderer, label: string): Promise<void> {
  const chip = renderer.root.findByProps({ accessibilityLabel: `Run on ${label}` });
  await act(async () => {
    await chip.props.onPress();
  });
}

function expectCreateDefaults(renderer: ReactTestRenderer): void {
  expect(fieldValue(renderer, CREATE_PLACEHOLDERS.name)).toBe('');
  expect(fieldValue(renderer, CREATE_PLACEHOLDERS.description)).toBe('');
  expect(fieldValue(renderer, CREATE_PLACEHOLDERS.soul)).toBe('');
  expect(fieldValue(renderer, CREATE_PLACEHOLDERS.modelId)).toBe('');
  expect(fieldValue(renderer, CREATE_PLACEHOLDERS.providerId)).toBe('');
}

function expectEditPrefill(renderer: ReactTestRenderer, initial: typeof EDIT_INITIAL): void {
  const name = renderer.root.findByProps({ placeholder: CREATE_PLACEHOLDERS.name });
  expect(String(name.props.value)).toBe(initial.name);
  // Renaming is not a thing: the identity field stays read-only while editing.
  expect(name.props.editable).toBe(false);
  expect(fieldValue(renderer, EDIT_PLACEHOLDERS.description)).toBe(initial.description);
  expect(fieldValue(renderer, EDIT_PLACEHOLDERS.soul)).toBe('');
  expect(fieldValue(renderer, EDIT_PLACEHOLDERS.modelId)).toBe(initial.modelId);
  expect(fieldValue(renderer, EDIT_PLACEHOLDERS.providerId)).toBe(initial.providerId);
}

describe('the mounted New Agent sheet starts over when it is shown again', () => {
  test('a successful create reopens on create defaults: fields, pin, runtime and key mode all reset', async () => {
    const onClose = jest.fn();
    const onSubmit = jest.fn();
    const props: SheetProps = { visible: true, onClose, onSubmit, runtimes: RUNTIMES };
    const renderer = await mountSheet({ ...props, visible: false });
    await renderUpdate(renderer, props);

    // A create on the second runtime, with every draft field filled in and the
    // key mode switched away from the default.
    await pressRuntime(renderer, 'OpenCode');
    expect(runtimeSelected(renderer, 'OpenCode')).toBe(true);
    await type(renderer, CREATE_PLACEHOLDERS.name, 'scout');
    await type(renderer, CREATE_PLACEHOLDERS.description, 'runs watcher');
    await type(renderer, CREATE_PLACEHOLDERS.soul, 'terse, evidence-first');
    await type(renderer, CREATE_PLACEHOLDERS.modelId, 'xai/grok');
    await type(renderer, CREATE_PLACEHOLDERS.providerId, 'xai');
    await pressLabeled(renderer, 'Inherit keys from default');
    expect(findButton(renderer, 'Empty key set')).toBeTruthy();

    await pressLabeled(renderer, 'Create');
    expect(onSubmit).toHaveBeenCalledWith({
      name: 'scout',
      soul: 'terse, evidence-first',
      inheritKeys: false,
      backendId: 'opencode-gate',
      description: 'runs watcher',
      modelId: 'xai/grok',
      providerId: 'xai',
    });

    // The create landed; the parent hides the sheet and the operator opens it
    // again. No unmount, so an unreset form would meet them still prefilled.
    await closeAndReopen(renderer, props);
    expectCreateDefaults(renderer);

    // The runtime choice goes back to the first row and the key mode back to
    // inheriting, rather than carrying the previous create's answers forward.
    expect(runtimeSelected(renderer, 'Hermes')).toBe(true);
    expect(runtimeSelected(renderer, 'OpenCode')).toBe(false);
    expect(findButton(renderer, 'Inherit keys from default')).toBeTruthy();
    expect(renderer.root.findAllByType(BUTTON).some((node) => node.props.label === 'Empty key set')).toBe(false);

    // Empty name means the reopened sheet cannot submit the previous Bot again.
    expect(findButton(renderer, 'Create').props.disabled).toBe(true);
    await act(async () => renderer.unmount());
  });

  test("a successful edit reopens on the Bot's current values, not on the edit that was saved", async () => {
    const onClose = jest.fn();
    const onSubmit = jest.fn();
    const props: SheetProps = { visible: true, onClose, onSubmit, initial: EDIT_INITIAL };
    const renderer = await mountSheet(props);
    expectEditPrefill(renderer, EDIT_INITIAL);

    await type(renderer, EDIT_PLACEHOLDERS.description, 'recut the anvil');
    await type(renderer, EDIT_PLACEHOLDERS.soul, 'only speaks when asked');
    await type(renderer, EDIT_PLACEHOLDERS.modelId, 'grok-5.1');
    await type(renderer, EDIT_PLACEHOLDERS.providerId, 'xai');

    await pressLabeled(renderer, 'Save');
    expect(onSubmit).toHaveBeenCalledWith({
      name: 'anvil',
      soul: 'only speaks when asked',
      inheritKeys: true,
      description: 'recut the anvil',
      modelId: 'grok-5.1',
      providerId: 'xai',
    });

    // The edit landed and the parent hid the sheet; the same Bot is edited
    // again (same key), so the form must read the Bot again — including the
    // soul the edit typed, which the Bot itself never carried.
    await closeAndReopen(renderer, props);
    expectEditPrefill(renderer, EDIT_INITIAL);
    await act(async () => renderer.unmount());
  });

  test('a blank description still means "leave untouched", and reopening reads the Bot again', async () => {
    const onClose = jest.fn();
    const onSubmit = jest.fn();
    const props: SheetProps = { visible: true, onClose, onSubmit, initial: EDIT_INITIAL };
    const renderer = await mountSheet(props);

    // Clearing the description is how the operator asks the Gate to keep what
    // it holds; the draft must carry `undefined`, not an empty string.
    await type(renderer, EDIT_PLACEHOLDERS.description, '');
    await pressLabeled(renderer, 'Save');
    expect(onSubmit).toHaveBeenCalledWith({
      name: 'anvil',
      soul: undefined,
      inheritKeys: true,
      description: undefined,
      modelId: EDIT_INITIAL.modelId,
      providerId: EDIT_INITIAL.providerId,
    });

    await closeAndReopen(renderer, props);
    expectEditPrefill(renderer, EDIT_INITIAL);
    await act(async () => renderer.unmount());
  });

  test('a refused submission keeps the draft while the sheet never hid', async () => {
    const onClose = jest.fn();
    const onSubmit = jest.fn();
    const props: SheetProps = { visible: true, onClose, onSubmit };
    const renderer = await mountSheet(props);

    await type(renderer, CREATE_PLACEHOLDERS.name, 'scout');
    await type(renderer, CREATE_PLACEHOLDERS.description, 'kept while refused');
    await pressLabeled(renderer, 'Create');
    expect(onSubmit).toHaveBeenCalledTimes(1);

    // The parent refuses and rerenders busy, then names the error. `visible`
    // never moved, so nothing may wipe the draft between those renders.
    await renderUpdate(renderer, { ...props, busy: true });
    await renderUpdate(renderer, { ...props, error: 'the Gate refused the create' });

    expect(fieldValue(renderer, CREATE_PLACEHOLDERS.name)).toBe('scout');
    expect(fieldValue(renderer, CREATE_PLACEHOLDERS.description)).toBe('kept while refused');
    renderer.root.findByProps({ children: 'the Gate refused the create' });
    await act(async () => renderer.unmount());
  });
});
