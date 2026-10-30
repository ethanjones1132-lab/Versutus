/**
 * VS-032 — the channel-status row put its detail PressableScale *inside* the
 * row Pressable that opens chat. On web both `accessibilityRole="button"`
 * elements render as real `<button>` elements, so the page shipped
 * `<button>...<button>` — the nested-interactive hydration error Terra saw on
 * Home, Activity and chat.
 *
 * These mount the real `ChannelStatusRow` (with a declaring status fixture)
 * and pin the replacement contract: the row action and the detail toggle are
 * sibling controls in a noninteractive container, each activates on its own,
 * the toggle announces expanded state, the detail is fully readable when
 * expanded, both keep native hit targets, and an undeclared group still hides
 * the row. The last test renders the component through react-native-web with
 * react-dom/server (both already installed) and asserts on the emitted HTML,
 * so a source-grep cannot stand in for the DOM structure.
 *
 * Browser keyboard operation itself is NOT exercised here — react-test-renderer
 * delivers press props, and server HTML cannot be typed into. Real browser
 * acceptance remains with the operator.
 */

// The real PressableScale + Text, with the native symbol view stubbed out: the
// chevron draws nothing on any assertion path. Importing the whole ui barrel
// would drag every native surface into the module graph.
jest.mock('@/components/ui', () => {
  const { PressableScale } = jest.requireActual<
    typeof import('@/components/ui/PressableScale')
  >('@/components/ui/PressableScale');
  const { Text } = jest.requireActual<typeof import('@/components/ui/Text')>(
    '@/components/ui/Text',
  );
  function Icon() {
    return null;
  }
  return { Icon, PressableScale, Text };
});

// PressableScale animates through reanimated, whose native worklet unpackers
// cannot load under jest-expo. Identity wrappers keep the real Pressable (and
// therefore its onPress) in the tree.
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { createAnimatedComponent: (component: unknown) => component },
  createAnimatedComponent: (component: unknown) => component,
  useSharedValue: (value: unknown) => ({ value }),
  useAnimatedStyle: () => ({}),
  withTiming: (value: unknown) => value,
  withSpring: (value: unknown) => value,
  Easing: {
    bezier: () => (value: number) => value,
    elastic: () => (value: number) => value,
  },
}));

// Motion choreography is outside the interaction contract. Keep the real
// PressableScale host/handlers without loading native animation presets.
jest.mock('@/lib/motion/hooks', () => ({
  usePressScale: () => ({ animatedStyle: {}, onPressIn: () => undefined, onPressOut: () => undefined }),
}));

import { createElement } from 'react';
import { StyleSheet, type GestureResponderEvent, type ViewStyle } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { ChannelStatusRow } from '@/components/gateway/channel-status-row';
import type { GatewayCapabilityGroup } from '@/lib/gateway/types';
import { CHIP_HIT_SLOP } from '@/lib/motion/chip-hit-slop';

const LABEL = 'Channels';
const DETAIL = '3 of 6 channel bridges healthy';
const EXPAND = 'Expand channel status detail';
const COLLAPSE = 'Collapse channel status detail';
const ROW_LABEL = `${LABEL} - ${DETAIL}`;

function declaringGroup(overrides: Partial<GatewayCapabilityGroup> = {}): GatewayCapabilityGroup {
  return {
    id: 'channels',
    label: LABEL,
    status: 'partial',
    note: DETAIL,
    ...overrides,
  };
}

let renderer: ReactTestRenderer | undefined;

async function mount(group: GatewayCapabilityGroup | undefined): Promise<jest.Mock> {
  const onPress = jest.fn();
  await act(async () => {
    renderer = create(createElement(ChannelStatusRow, { group, onPress }));
  });
  return onPress;
}

/**
 * The outermost mounted node carrying a control's accessible name and press
 * handler. Inner Pressable wrappers repeat both, so depth-first order matters.
 */
function control(label: string): ReactTestInstance {
  if (!renderer) throw new Error('no channel status row mounted');
  const matches = renderer.root.findAll(
    (node) => node.props.accessibilityLabel === label && typeof node.props.onPress === 'function',
  );
  expect(matches.length).toBeGreaterThan(0);
  return matches[0];
}

function detailText(): ReactTestInstance {
  if (!renderer) throw new Error('no channel status row mounted');
  const matches = renderer.root.findAll(
    (node) =>
      typeof node.type === 'string' && String(node.type) === 'Text' && node.props.children === DETAIL,
  );
  expect(matches).toHaveLength(1);
  return matches[0];
}

/** Host-component interactive ancestors only; component props like the row's own onPress are not DOM. */
function interactiveHostAncestors(node: ReactTestInstance): ReactTestInstance[] {
  const ancestors: ReactTestInstance[] = [];
  let parent = node.parent;
  while (parent) {
    if (
      typeof parent.type === 'string' &&
      (parent.props.accessibilityRole === 'button' || typeof parent.props.onPress === 'function')
    ) {
      ancestors.push(parent);
    }
    parent = parent.parent;
  }
  return ancestors;
}

function press(node: ReactTestInstance, event: Partial<GestureResponderEvent> = {}) {
  const pressEvent = { stopPropagation: jest.fn(), ...event };
  act(() => {
    node.props.onPress(pressEvent);
  });
  return pressEvent;
}

afterEach(async () => {
  const doomed = renderer;
  renderer = undefined;
  if (doomed) {
    await act(async () => {
      doomed.unmount();
    });
  }
});

describe('channel status row sibling controls (VS-032)', () => {
  test('no interactive ancestor wraps the detail button, and both controls are siblings', async () => {
    await mount(declaringGroup());

    const rowAction = control(ROW_LABEL);
    const detailToggle = control(EXPAND);

    // This is the structural regression: with the old component the detail
    // PressableScale sat inside the row Pressable, so this list held the row.
    expect(interactiveHostAncestors(detailToggle)).toEqual([]);
    expect(interactiveHostAncestors(rowAction)).toEqual([]);

    // Same noninteractive container, not one inside the other.
    expect(detailToggle.parent).toBe(rowAction.parent);
    expect(detailToggle.parent?.props.accessibilityRole).toBeUndefined();
    expect(typeof detailToggle.parent?.props.onPress).toBe('undefined');
  });

  test('row navigation and detail expansion activate independently', async () => {
    const onPress = await mount(declaringGroup());

    const stopPropagation = jest.fn();
    const detailToggle = control(EXPAND);
    act(() => {
      detailToggle.props.onPress({ stopPropagation } as unknown as GestureResponderEvent);
    });

    // The detail action never navigates, and still swallows the event.
    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(onPress).not.toHaveBeenCalled();
    expect(control(COLLAPSE)).toBeDefined();

    // The row action navigates without collapsing the detail again.
    press(control(ROW_LABEL));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(control(COLLAPSE)).toBeDefined();
  });

  test('the toggle announces expanded state and clears the one-line clamp', async () => {
    await mount(declaringGroup());

    const collapsed = control(EXPAND);
    expect(collapsed.props.accessibilityState).toMatchObject({ expanded: false });
    expect(collapsed.props['aria-expanded']).toBe(false);
    expect(detailText().props.numberOfLines).toBe(1);

    press(collapsed);

    const expanded = control(COLLAPSE);
    expect(expanded.props.accessibilityState).toMatchObject({ expanded: true });
    expect(expanded.props['aria-expanded']).toBe(true);
    expect(detailText().props.numberOfLines).toBeUndefined();

    press(expanded);

    expect(control(EXPAND).props.accessibilityState).toMatchObject({ expanded: false });
    expect(detailText().props.numberOfLines).toBe(1);
  });

  test('both controls keep native names, roles and 44dp hit targets', async () => {
    await mount(declaringGroup());

    const rowAction = control(ROW_LABEL);
    expect(rowAction.props.accessibilityRole).toBe('button');
    expect(rowAction.props.accessibilityLabel).toBe(`${LABEL} - ${DETAIL}`);
    expect(StyleSheet.flatten(rowAction.props.style as ViewStyle).minHeight).toBeGreaterThanOrEqual(
      44,
    );

    const detailToggle = control(EXPAND);
    expect(detailToggle.props.accessibilityRole).toBe('button');
    expect(detailToggle.props.accessibilityLabel).toBe(EXPAND);
    expect(detailToggle.props.hitSlop).toEqual(CHIP_HIT_SLOP);
    expect(
      StyleSheet.flatten(detailToggle.props.style as ViewStyle).minHeight,
    ).toBeGreaterThanOrEqual(44);
  });

  test('an undeclared channel group still hides the row', async () => {
    await mount(declaringGroup({ status: 'undeclared' }));
    expect(renderer?.toJSON()).toBeNull();
  });
});

// ─── Real web render: the buttons must be siblings in the emitted HTML ──────

type TagFrame = { tag: string; interactive: boolean };

/**
 * Walk the server-emitted HTML and return how many interactive elements are
 * still open when the element carrying `aria-label` starts. React Native Web
 * renders `accessibilityRole="button"` as a real `<button>`, which is exactly
 * the element browsers reject as a descendant of another button.
 */
function interactiveAncestorsOf(markup: string, ariaLabel: string): number {
  const marker = `aria-label="${ariaLabel}"`;
  const frames: TagFrame[] = [];
  for (const token of markup.match(/<[^>]+>/g) ?? []) {
    const tag = token.match(/^<\/?([a-zA-Z][\w:-]*)/)?.[1]?.toLowerCase();
    if (!tag) continue;

    if (token.startsWith('</')) {
      const index = frames.map((frame) => frame.tag).lastIndexOf(tag);
      if (index >= 0) frames.length = index;
      continue;
    }

    if (token.includes(marker)) {
      return frames.filter((frame) => frame.interactive).length;
    }

    const interactive =
      ['button', 'a', 'input', 'select', 'textarea'].includes(tag) ||
      /\brole="(button|link|checkbox|switch|tab)"/.test(token) ||
      /\btabindex="0"/.test(token);
    if (!/\/>$/.test(token)) frames.push({ tag, interactive });
  }
  throw new Error(`no rendered element carried ${marker}`);
}

function openingTagFor(markup: string, ariaLabel: string): string {
  const marker = `aria-label="${ariaLabel}"`;
  const token = (markup.match(/<[^>]+>/g) ?? []).find((candidate) => candidate.includes(marker));
  if (!token) throw new Error(`no rendered element carried ${marker}`);
  return token;
}

test('the web render emits the detail button beside the row button, not inside it', () => {
  // Start a fresh module registry so the ui-barrel mock and PressableScale are
  // built against react-native-web rather than the native aliases already
  // loaded for the behavioural tests above. This test runs last in the file.
  jest.resetModules();
  // Render the real component through react-native-web's own host primitives
  // instead of the native aliases, then serialize with react-dom/server. Both
  // are already project dependencies; no test harness or preset is changed.
  jest.doMock('react-native', () => ({
    Platform: jest.requireActual('react-native-web/dist/cjs/exports/Platform'),
    Pressable: jest.requireActual('react-native-web/dist/cjs/exports/Pressable'),
    StyleSheet: jest.requireActual('react-native-web/dist/cjs/exports/StyleSheet'),
    Text: jest.requireActual('react-native-web/dist/cjs/exports/Text'),
    View: jest.requireActual('react-native-web/dist/cjs/exports/View'),
  }));
  const React = jest.requireActual<typeof import('react')>('react');
  const { renderToStaticMarkup } = jest.requireActual('react-dom/server') as {
    renderToStaticMarkup: (element: unknown) => string;
  };
  const { ChannelStatusRow: WebChannelStatusRow } = jest.requireActual<
    typeof import('@/components/gateway/channel-status-row')
  >('@/components/gateway/channel-status-row');

  const markup = renderToStaticMarkup(
    React.createElement(WebChannelStatusRow, {
      group: declaringGroup(),
      onPress: () => undefined,
    }),
  );

  const buttons = markup.match(/<button\b/g) ?? [];
  expect(buttons).toHaveLength(2);

  const rowAction = openingTagFor(markup, ROW_LABEL);
  expect(rowAction).toContain('<button');
  expect(rowAction).toContain('tabindex="0"');

  const detailToggle = openingTagFor(markup, EXPAND);
  expect(detailToggle).toContain('<button');
  expect(detailToggle).toContain('tabindex="0"');
  expect(detailToggle).toContain('aria-expanded="false"');

  // The regression itself: old markup had the detail <button> inside the row
  // <button>, so this count was 1.
  expect(interactiveAncestorsOf(markup, EXPAND)).toBe(0);
  expect(interactiveAncestorsOf(markup, ROW_LABEL)).toBe(0);

  // Expanding is still a real detail surface, not a truncated decorative line:
  // the full verdict is present in the toggle's text.
  expect(markup).toContain(DETAIL);
});
