// VS-004: "Keep this look" must not report success when the device refused the
// write. These cases drive the real studio button, the real `keep`, and the
// real `saveBotLook` over a key-value store that rejects.

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
  class Keyframe {
    duration(duration: number) {
      return { duration };
    }
  }
  return {
    __esModule: true,
    default: { View, Text, ScrollView, Pressable, createAnimatedComponent },
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
    withTiming: (value: unknown, _c?: unknown, cb?: (finished: boolean) => void) => {
      if (typeof cb === 'function') cb(true);
      return value;
    },
    withSpring: (value: unknown) => value,
    withRepeat: (value: unknown) => value,
    runOnJS: (fn: unknown) => fn,
    Keyframe,
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

jest.mock('@/components/avatar/colour-wheel', () => ({
  ColourWheel: () => null,
  wheelRings: () => ({ hole: 72 }),
}));

jest.mock('@/components/avatar/bot-figure', () => ({
  BotFigure: () => null,
}));

jest.mock('@/lib/haptics', () => ({
  haptics: {
    selection: jest.fn(async () => undefined),
    light: jest.fn(async () => undefined),
    success: jest.fn(async () => undefined),
  },
}));

jest.mock('@/lib/storage/key-value', () => ({
  keyValueStorage: {
    getItem: jest.fn(),
    setItem: jest.fn(),
    removeItem: jest.fn(),
    getAllKeys: jest.fn(),
    multiRemove: jest.fn(),
  },
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: unknown }) => children,
}));

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

import { createElement, type ElementType } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { LookStudioSheet } from '@/components/avatar/look-studio-sheet';
import { BaseSheet, Button, PressableScale, Text } from '@/components/ui';
import { AVATAR_FACES, AVATAR_FACE_NAMES, botLookIn } from '@/lib/avatar/look';
import { BOT_LOOKS_KEY, resetBotLooksForTests, saveBotLook } from '@/lib/avatar/look-store';
import { crestFleetSnapshot, crestLooksSnapshot } from '@/lib/bot-avatar';
import { haptics } from '@/lib/haptics';
import { keyValueStorage } from '@/lib/storage/key-value';

const BUTTON = Button as unknown as ElementType;
const PRESSABLE = PressableScale as unknown as ElementType;
const TEXT = Text as unknown as ElementType;
const BASE_SHEET = BaseSheet as unknown as ElementType;

const mockGet = keyValueStorage.getItem as jest.Mock;
const mockSet = keyValueStorage.setItem as jest.Mock;
const mockSuccess = haptics.success as jest.Mock;

const BOT_ID = 'aria';
const BOT_NAME = 'Aria';
const KEEP_LABEL = 'Keep this look';
const NOT_SAVED = 'This look was not saved. Please try again.';

/** The strings the UI component passed as Text children. */
function textOf(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType(TEXT)
    .map((node) => node.props.children)
    .filter((child): child is string => typeof child === 'string');
}

async function openStudio(onClose: jest.Mock): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(LookStudioSheet, { botId: BOT_ID, name: BOT_NAME, onClose }));
  });
  return renderer;
}

/** Make the draft differ from the Bot's current look, so the button says Keep. */
function chooseAnotherFace(renderer: ReactTestRenderer): void {
  const current = botLookIn(crestFleetSnapshot(), crestLooksSnapshot(), BOT_ID, BOT_NAME);
  const face = AVATAR_FACES.find((candidate) => candidate !== current.face);
  if (!face) throw new Error('no other face to choose');
  const label = AVATAR_FACE_NAMES[face];
  const tile = renderer.root.findAllByType(PRESSABLE).find((node) => node.props.accessibilityLabel === label);
  if (!tile) throw new Error(`face tile "${label}" was not rendered`);
  act(() => {
    tile.props.onPress();
  });
}

async function pressKeep(renderer: ReactTestRenderer): Promise<void> {
  const keep = renderer.root.findAllByType(BUTTON).find((node) => node.props.label === KEEP_LABEL);
  if (!keep) throw new Error(`"${KEEP_LABEL}" was not rendered`);
  await act(async () => {
    keep.props.onPress();
    // Let keep()'s awaited save settle before the assertions.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  resetBotLooksForTests();
  mockGet.mockReset().mockResolvedValue(null);
  mockSet.mockReset();
  mockSuccess.mockClear();
});

afterEach(() => {
  resetBotLooksForTests();
});

describe('VS-004 keeping a look the device refuses', () => {
  test('a rejected write resolves false instead of throwing, and the look is still drawn', async () => {
    mockSet.mockRejectedValue(new Error('device storage refused the write'));

    await expect(saveBotLook(BOT_ID, { face: 'starry' })).resolves.toBe(false);

    expect(mockSet).toHaveBeenCalledWith(BOT_LOOKS_KEY, expect.any(String));
    expect(crestLooksSnapshot().get(BOT_ID)).toEqual({ face: 'starry' });
  });

  test('the sheet stays open, says the look was not saved, and fires no success haptic', async () => {
    mockSet.mockRejectedValue(new Error('device storage refused the write'));
    const onClose = jest.fn();
    const renderer = await openStudio(onClose);

    chooseAnotherFace(renderer);
    await pressKeep(renderer);

    expect(mockSet).toHaveBeenCalledTimes(1);
    expect(mockSuccess).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    // Still open, with the refusal line. The refused write is drawn for this
    // run, so the draft now matches and the button reads Done instead of Keep.
    expect(renderer.root.findByType(BASE_SHEET).props.visible).toBe(true);
    expect(textOf(renderer)).toContain(NOT_SAVED);
    expect(renderer.root.findAllByType(BUTTON).some((node) => node.props.label === 'Done')).toBe(true);
    expect(renderer.root.findAllByType(BUTTON).some((node) => node.props.label === KEEP_LABEL)).toBe(false);

    await act(async () => {
      renderer.unmount();
    });
  });

  test('a write the device keeps still closes the sheet and fires the success haptic', async () => {
    mockSet.mockResolvedValue(undefined);
    const onClose = jest.fn();
    const renderer = await openStudio(onClose);

    chooseAnotherFace(renderer);
    await pressKeep(renderer);

    expect(mockSet).toHaveBeenCalledTimes(1);
    expect(mockSuccess).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(textOf(renderer)).not.toContain(NOT_SAVED);

    await act(async () => {
      renderer.unmount();
    });
  });
});
