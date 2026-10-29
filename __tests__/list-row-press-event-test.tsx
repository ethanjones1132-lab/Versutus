/**
 * VS-034 — "Providers & gateways" in Settings > Gate did nothing on web.
 *
 * That row (and "Your PC", and "Runtime environment") is a `RowGroupRow` inside
 * `Link asChild`. The router's `asChild` forwards its own `onPress` to the child
 * (`expo-router@57.0.12`, `link/BaseExpoRouterLink.js`), and on web that handler
 * is `useLinkToPathProps`' `onPress`, which only navigates when
 * `shouldHandleMouseEvent(event)` says so:
 *
 *   if (event && eventShouldPreventDefault(event)) { event.preventDefault(); return true }
 *   return false;                                  // web, event undefined
 *
 * `eventShouldPreventDefault` also reads `event.currentTarget.target` — an
 * event whose click has finished dispatching has a null `currentTarget`, so the
 * handler must both *receive* an event and be given it while it is still live.
 * `ListRow` used to call `onPress?.()` with no argument, after awaiting the
 * haptic, so the injected handler was handed `undefined` and every such row
 * silently stayed put.
 *
 * These mount the real `ListRow`/`RowGroupRow` (react-test-renderer is what this
 * repo has; press events are delivered the way `Pressable` delivers them) and
 * pin the three things the fix has to keep true: the caller gets the event, it
 * is still live when the caller reads it, and the haptic still plays.
 */
jest.mock('expo-haptics', () => ({
  __esModule: true,
  selectionAsync: jest.fn(async () => undefined),
  impactAsync: jest.fn(async () => undefined),
  notificationAsync: jest.fn(async () => undefined),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}));

// `PressableScale` animates through reanimated, whose native worklet unpackers
// cannot load under jest-expo. An identity `createAnimatedComponent` keeps the
// real `Pressable` — and therefore its `onPress` — in the tree.
jest.mock('react-native-reanimated', () => {
  const { Pressable, View } = require('react-native') as typeof import('react-native');
  const createAnimatedComponent = (component: unknown) => component;
  const chain = () => {
    const builder = {
      duration: () => builder,
      easing: () => builder,
      delay: () => builder,
      withInitialValues: () => builder,
    };
    return builder;
  };
  return {
    __esModule: true,
    default: { View, Pressable, createAnimatedComponent },
    createAnimatedComponent,
    Easing: {
      bezier: () => (value: number) => value,
      elastic: () => (value: number) => value,
      ease: (value: number) => value,
      inOut: (fn: unknown) => fn,
      quad: (fn: unknown) => fn,
    },
    FadeIn: chain(),
    FadeInDown: chain(),
    FadeOut: chain(),
    useSharedValue: (value: unknown) => ({ value, get: () => value, set: () => undefined }),
    useAnimatedStyle: () => ({}),
    withTiming: (value: unknown) => value,
    withSpring: (value: unknown) => value,
  };
});

// The glyph is a native symbol view; nothing under test draws or reads it.
jest.mock('@/components/ui/Icon', () => ({ Icon: 'Icon' }));

// `RowGroup`'s fill is a `GlassSurface`, whose iOS variant pulls the native
// liquid-glass view. Its default flat path renders a plain `View`; the stand-in
// only keeps the native module out of the module graph.
jest.mock('expo-glass-effect', () => ({ GlassView: 'GlassView' }));

import * as Haptics from 'expo-haptics';
import { createElement, type ReactElement } from 'react';
import { type GestureResponderEvent } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { ListRow } from '@/components/ui/ListRow';
import { RowGroupRow } from '@/components/ui/RowGroup';

const ROW = 'Providers & gateways';

/** The fields expo-router's web link handler reads off a press. */
type WebClickEvent = {
  button: number;
  metaKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  defaultPrevented: boolean;
  currentTarget: { target?: string };
  preventDefault: () => void;
  nativeEvent: { type: string };
};

/**
 * A press as `react-native-web`'s `Pressable` delivers it on web: the click
 * itself (`PressResponder` calls `onPress(event)` from its `onClick`). Every
 * field the router reads throws once the click has finished dispatching, the
 * way a null `currentTarget` and a too-late `preventDefault()` do in a browser.
 */
function webClick(): { event: GestureResponderEvent; endDispatch: () => void } {
  let dispatching = true;
  const live = (): void => {
    if (!dispatching) {
      throw new Error('the press event was read after its click had finished dispatching');
    }
  };
  const event = {
    get button(): number {
      live();
      return 0;
    },
    get metaKey(): boolean {
      live();
      return false;
    },
    get altKey(): boolean {
      live();
      return false;
    },
    get ctrlKey(): boolean {
      live();
      return false;
    },
    get shiftKey(): boolean {
      live();
      return false;
    },
    get currentTarget(): { target?: string } {
      live();
      return { target: undefined };
    },
    defaultPrevented: false,
    preventDefault(): void {
      live();
      this.defaultPrevented = true;
    },
    nativeEvent: { type: 'click' },
  };
  return {
    event: event as unknown as GestureResponderEvent,
    endDispatch: () => {
      dispatching = false;
    },
  };
}

let renderer: ReactTestRenderer | undefined;

async function mount(element: ReactElement): Promise<void> {
  await act(async () => {
    renderer = create(element);
  });
}

function row(label: string): ReactTestInstance {
  if (!renderer) {
    throw new Error('no row mounted');
  }
  // RN's lazy Pressable export under jest-expo need not retain the identity
  // imported by the animation mock. Follow the actual mounted action through
  // the wrappers, and require that they all expose the same press callback.
  const found = renderer.root.findAll(
    (node) => node.props.accessibilityLabel === label && typeof node.props.onPress === 'function',
  );
  expect(found.length).toBeGreaterThan(0);
  expect(new Set(found.map((node) => node.props.onPress)).size).toBe(1);
  return found[found.length - 1];
}

/** Press the row; resolves once the row's handler and its haptic have settled. */
function press(label: string, event: GestureResponderEvent): Promise<void> {
  const onPress = row(label).props.onPress as (pressEvent: GestureResponderEvent) => Promise<void>;
  expect(typeof onPress).toBe('function');
  return onPress(event);
}

afterEach(async () => {
  const doomed = renderer;
  renderer = undefined;
  if (doomed) {
    await act(async () => {
      doomed.unmount();
    });
  }
  jest.clearAllMocks();
});

describe('a row hands its press event to onPress (VS-034)', () => {
  test('ListRow passes the event, and still plays the selection haptic', async () => {
    const onPress = jest.fn();
    await mount(createElement(ListRow, { title: ROW, onPress }));

    const { event } = webClick();
    await act(async () => {
      await press(ROW, event);
    });

    expect(onPress).toHaveBeenCalledTimes(1);
    // Identity, not shape: the router's handler reads the very click it was
    // given. `onPress?.()` handed it nothing at all.
    expect(onPress.mock.calls[0]?.[0]).toBe(event);
    expect(Haptics.selectionAsync).toHaveBeenCalledTimes(1);
  });

  test('RowGroupRow — the type the Settings screen wraps in Link — passes the event', async () => {
    const onPress = jest.fn();
    await mount(createElement(RowGroupRow, { title: ROW, onPress }));

    const { event } = webClick();
    await act(async () => {
      await press(ROW, event);
    });

    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onPress.mock.calls[0]?.[0]).toBe(event);
    expect(Haptics.selectionAsync).toHaveBeenCalledTimes(1);
  });

  test('the event is still live when the caller reads it, so a web Link navigates', async () => {
    const navigate = jest.fn();
    // `useLinkToPathProps`' handler, reduced to the reads it makes.
    const linkOnPress = jest.fn((pressEvent: GestureResponderEvent) => {
      const click = pressEvent as unknown as WebClickEvent;
      const shouldHandle =
        !click.defaultPrevented &&
        click.button === 0 &&
        !click.metaKey &&
        !click.altKey &&
        !click.ctrlKey &&
        !click.shiftKey &&
        [undefined, null, '', 'self'].includes(click.currentTarget.target);
      if (!shouldHandle) return;
      click.preventDefault();
      navigate('/gateway/setup');
    });

    await mount(createElement(RowGroupRow, { title: ROW, onPress: linkOnPress }));

    const { event, endDispatch } = webClick();
    await act(async () => {
      const pressed = press(ROW, event);
      // The click is over the moment the handler returns; only the haptic is
      // still in flight. An implementation that awaits before calling back
      // would read a dead event here and fail on the getter.
      endDispatch();
      await pressed;
    });

    expect(linkOnPress).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/gateway/setup');
  });

  test('a zero-argument caller behaves exactly as before', async () => {
    let taps = 0;
    await mount(
      createElement(ListRow, {
        title: ROW,
        onPress: () => {
          taps += 1;
        },
      }),
    );

    const { event } = webClick();
    await act(async () => {
      await press(ROW, event);
    });

    expect(taps).toBe(1);
  });

  test('long press is unchanged: it calls onLongPress and never onPress', async () => {
    const onPress = jest.fn();
    const onLongPress = jest.fn();
    await mount(createElement(ListRow, { title: ROW, onPress, onLongPress }));

    const onLongPressHandler = row(ROW).props.onLongPress as () => Promise<void>;
    expect(typeof onLongPressHandler).toBe('function');
    await act(async () => {
      await onLongPressHandler();
    });

    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onPress).not.toHaveBeenCalled();
    expect(Haptics.selectionAsync).toHaveBeenCalledTimes(1);
  });
});
