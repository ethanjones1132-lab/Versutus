jest.mock('react-native-reanimated', () => {
  const { View, Text, ScrollView, Pressable } = require('react-native');
  const easing = new Proxy(
    {
      bezier: () => (value: number) => value,
      elastic: () => (value: number) => value,
      ease: () => (value: number) => value,
      out: (fn: (value: number) => number) => fn,
      inOut: (fn: (value: number) => number) => fn,
      cubic: (value: number) => value,
      sin: (value: number) => value,
      quad: (value: number) => value,
    },
    { get: (target, key) => (key in target ? target[key as keyof typeof target] : () => (value: number) => value) },
  );
  const chain = (): unknown => {
    const proxy: unknown = new Proxy(function () {}, {
      get: (_t, key) => (key === 'then' ? undefined : proxy),
      apply: () => proxy,
    });
    return proxy;
  };
  const createAnimatedComponent = (component: unknown) => component;
  return {
    __esModule: true,
    default: { View, Text, ScrollView, Pressable, createAnimatedComponent },
    Easing: easing,
    useSharedValue: (value: unknown) => ({ value, get: () => value, set: () => undefined }),
    useAnimatedStyle: () => ({}),
    useAnimatedKeyboard: () => ({ height: { value: 0 } }),
    useReducedMotion: () => true,
    withTiming: (value: unknown, _cfg?: unknown, cb?: (finished: boolean) => void) => {
      if (typeof cb === 'function') cb(true);
      return value;
    },
    withSpring: (value: unknown) => value,
    withRepeat: (value: unknown) => value,
    withSequence: (value: unknown) => value,
    runOnJS: (fn: unknown) => fn,
    FadeIn: { duration: chain, easing: chain, delay: chain },
    FadeOut: { duration: chain, easing: chain, delay: chain },
    FadeInDown: { duration: chain, easing: chain, delay: chain },
    createAnimatedComponent,
    View,
    Text,
    ScrollView,
    Keyframe: class {
      duration() {
        return this;
      }
      easing() {
        return this;
      }
    },
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

jest.mock('react-native-svg', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: View,
    Defs: View,
    LinearGradient: View,
    RadialGradient: View,
    Rect: View,
    Stop: View,
    Circle: View,
  };
});

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

jest.mock('@/components/chat/composer-lens', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    ComposerBezel: ({ children }: { children: unknown }) => React.createElement(View, null, children),
    LaunchRing: () => null,
    SendOrb: () => null,
  };
});

jest.mock('@/components/layout/ComposerKeyboardLift', () => ({
  ComposerKeyboardLift: ({ children }: { children: unknown }) => children,
}));

jest.mock('expo-haptics', () => ({
  selectionAsync: async () => undefined,
  impactAsync: async () => undefined,
  notificationAsync: async () => undefined,
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}));

jest.mock('@/lib/voice/speech-recognition', () => ({
  speechRecognitionAvailable: jest.fn(async () => true),
  speechRecognitionPermissionAskable: jest.fn(async () => true),
  startSpeechRecognition: jest.fn(),
  stopSpeechRecognition: jest.fn(async () => undefined),
  cancelSpeechRecognition: jest.fn(async () => undefined),
}));

import { createElement, useCallback, useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { ChatComposer } from '@/components/chat/chat-composer';
import {
  cancelSpeechRecognition,
  startSpeechRecognition,
  stopSpeechRecognition,
} from '@/lib/voice/speech-recognition';

const mockStart = startSpeechRecognition as jest.Mock;
const mockStop = stopSpeechRecognition as jest.Mock;
const mockCancel = cancelSpeechRecognition as jest.Mock;

type TranscriptListener = (transcript: string, isFinal?: boolean) => void;

function byLabel(root: ReactTestRenderer['root'], label: string) {
  return root.findAll((node) => node.props.accessibilityLabel === label);
}

const baseProps = {
  onSend: jest.fn(),
  onStop: jest.fn(),
  isStreaming: false,
  canSend: true,
  status: 'connected' as const,
};

describe('hold-to-talk keeps the mic until release and stops on leave', () => {
  let onTranscript: TranscriptListener | undefined;

  beforeEach(() => {
    onTranscript = undefined;
    mockStart.mockReset();
    mockStop.mockReset();
    mockCancel.mockReset();
    mockStop.mockResolvedValue(undefined);
    mockCancel.mockResolvedValue(undefined);
    mockStart.mockImplementation((_opts: unknown, listener: TranscriptListener) => {
      onTranscript = listener;
      return Promise.resolve(true);
    });
  });

  test('CMP-1: a partial transcript does not swap the mic for send; release still stops recognition', async () => {
    let draft = '';
    let renderer!: ReactTestRenderer;
    const onChangeText = (text: string) => {
      draft = text;
      renderer.update(
        createElement(ChatComposer, {
          ...baseProps,
          draft,
          onChangeText,
        }),
      );
    };

    await act(async () => {
      renderer = create(
        createElement(ChatComposer, {
          ...baseProps,
          draft: '',
          onChangeText,
        }),
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    const mic = byLabel(renderer.root, 'Hold to talk')[0];
    expect(mic).toBeDefined();

    await act(async () => {
      mic.props.onPressIn?.();
      await Promise.resolve();
    });

    expect(mockStart).toHaveBeenCalled();
    expect(onTranscript).toBeDefined();

    await act(async () => {
      onTranscript?.('hello');
      await Promise.resolve();
    });

    expect(draft).toBe('hello');
    const micAfter = byLabel(renderer.root, 'Hold to talk')[0];
    expect(micAfter).toBeDefined();

    await act(async () => {
      micAfter.props.onPressOut?.();
      await Promise.resolve();
    });

    expect(mockStop).toHaveBeenCalled();
    renderer.unmount();
  });

  test('CMP-2: unmounting mid-hold cancels recognition and ignores further transcripts', async () => {
    const writes: string[] = [];
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        createElement(ChatComposer, {
          ...baseProps,
          draft: '',
          onChangeText: (text: string) => {
            writes.push(text);
          },
        }),
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    const mic = byLabel(renderer.root, 'Hold to talk')[0];
    await act(async () => {
      mic.props.onPressIn?.();
      await Promise.resolve();
    });

    await act(async () => {
      onTranscript?.('hello');
      await Promise.resolve();
    });
    expect(writes).toContain('hello');

    await act(async () => {
      renderer.unmount();
    });

    expect(mockCancel).toHaveBeenCalled();

    const before = writes.length;
    onTranscript?.('hello world');
    expect(writes.length).toBe(before);
  });

  test('CMP-2: switching the draft writer mid-hold cancels and does not write the abandoned thread', async () => {
    const threadA: string[] = [];
    const threadB: string[] = [];

    function Host({ thread }: { thread: 'a' | 'b' }) {
      const writeA = useCallback((text: string) => {
        threadA.push(text);
      }, []);
      const writeB = useCallback((text: string) => {
        threadB.push(text);
      }, []);
      const [draft] = useState('');
      return createElement(ChatComposer, {
        ...baseProps,
        draft,
        onChangeText: thread === 'a' ? writeA : writeB,
      });
    }

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(createElement(Host, { thread: 'a' }));
    });
    await act(async () => {
      await Promise.resolve();
    });

    const mic = byLabel(renderer.root, 'Hold to talk')[0];
    await act(async () => {
      mic.props.onPressIn?.();
      await Promise.resolve();
    });

    await act(async () => {
      renderer.update(createElement(Host, { thread: 'b' }));
    });

    expect(mockCancel).toHaveBeenCalled();

    onTranscript?.('into the wrong thread');
    expect(threadA).not.toContain('into the wrong thread');
    expect(threadB).not.toContain('into the wrong thread');

    renderer.unmount();
  });
});
