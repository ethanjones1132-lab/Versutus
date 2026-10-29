// ─── JSON command results honour the inline preview cap ─────────────────────
// The JSON branch of CommandResultView used to ignore `preview`: a large
// gateway result rendered a full JsonView FlatList with no viewport inside the
// terminal's outer list cell, so the nested list lost its windowing while the
// text branch was already capped at 240px. These tests mount the real
// component and the real JsonView (parsing and tree building run for real)
// and pin the structural contract: preview JSON gets the existing 240px
// maxHeight viewport around the tree, the full-output sheet gets none, and the
// complete value still reaches JsonView in both modes.
//
// react-test-renderer does not run Yoga, so measured pixel geometry is not
// available here. The assertions read the style bound on the host wrapper that
// contains JsonView plus the FlatList's data/props. That proves the constraint
// is present and the scroll/windowing host is intact — not the on-device
// rendered height.

import { createElement } from 'react';
import { FlatList, ScrollView } from 'react-native';
import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';

import { CommandResultView } from '@/components/terminal/command-result-view';
import { JsonView } from '@/components/terminal/json-view';
import type { JsonTreeRow } from '@/lib/terminal/json-tree';

// The inline cap the text preview already uses (command-result-view.tsx).
const PREVIEW_CAP = 240;

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));
jest.mock('react-native-reanimated', () => ({
  Easing: {
    bezier: () => (value: number) => value,
    elastic: () => (value: number) => value,
  },
}));
jest.mock('@/lib/haptics', () => ({
  haptics: { light: jest.fn(), success: jest.fn() },
}));
jest.mock('@/hooks/use-tokens', () => ({
  useTokens: () => ({
    accent: '#0af',
    accentWarm: '#fa0',
    textPrimary: '#fff',
    textSecondary: '#ccc',
    textTertiary: '#999',
    statusDisconnected: '#f66',
    statusDisconnectedMuted: '#511',
  }),
}));
jest.mock('@/components/ui', () => ({ Text: 'Text' }));

const LARGE_JSON = {
  sessions: Array.from({ length: 40 }, (_, index) => ({
    id: `sess-${index}`,
    title: `Session ${index}`,
    active: index % 2 === 0,
  })),
  total: 40,
  cursor: null,
};
const LARGE_LOG = JSON.stringify(LARGE_JSON);

const mounted: ReactTestRenderer[] = [];

async function mount(log: string, preview: boolean): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(CommandResultView, { log, preview }));
  });
  mounted.push(renderer);
  return renderer;
}

afterEach(async () => {
  for (const renderer of mounted.splice(0)) {
    await act(async () => {
      renderer.unmount();
    });
  }
});

function maxHeightOf(style: unknown): number | undefined {
  const entries = Array.isArray(style) ? style : [style];
  for (const entry of entries) {
    if (entry && typeof entry === 'object' && 'maxHeight' in entry) {
      const height = (entry as { maxHeight: unknown }).maxHeight;
      if (typeof height === 'number') return height;
    }
  }
  return undefined;
}

type Bound = { node: ReactTestInstance; maxHeight: number };

/** Every maxHeight viewport wrapping the node, nearest first. */
function viewportBounds(node: ReactTestInstance): Bound[] {
  const bounds: Bound[] = [];
  let current = node.parent;
  while (current) {
    const maxHeight = maxHeightOf(current.props.style as unknown);
    if (maxHeight !== undefined) bounds.push({ node: current, maxHeight });
    current = current.parent;
  }
  return bounds;
}

/** Ancestor component types, nearest first. */
function ancestorTypes(node: ReactTestInstance): unknown[] {
  const types: unknown[] = [];
  let current = node.parent;
  while (current) {
    types.push(current.type);
    current = current.parent;
  }
  return types;
}

/** Concatenated text leaves, so mocked UI leaves stay inspectable. */
function textOf(renderer: ReactTestRenderer): string {
  const collected: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      collected.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === 'object' && 'children' in node) {
      walk((node as { children: unknown }).children);
    }
  };
  walk(renderer.toJSON());
  return collected.join('\n');
}

test('regression: inline JSON gets the 240px viewport and the full sheet stays uncapped', async () => {
  const inline = await mount(LARGE_LOG, true);
  const inlineTree = inline.root.findByType(JsonView);
  const inlineBounds = viewportBounds(inlineTree);

  // The nearest cap is the wrapper this component owns, directly around the
  // tree — not some unrelated ancestor that happens to set a height.
  expect(inlineBounds.length).toBeGreaterThan(0);
  expect(inlineBounds[0].maxHeight).toBe(PREVIEW_CAP);
  expect(inlineBounds[0].node.type).toBe('View');
  expect(inlineTree.parent?.type).toBe('View');
  expect(maxHeightOf(inlineTree.parent?.props.style)).toBe(PREVIEW_CAP);

  // The full-output sheet path must not inherit the inline cap.
  const full = await mount(LARGE_LOG, false);
  expect(viewportBounds(full.root.findByType(JsonView))).toEqual([]);

  // The bound comes from the preview flag, not from how large the result is:
  // a one-line result gets the same viewport.
  const small = await mount('{"a":1}', true);
  expect(viewportBounds(small.root.findByType(JsonView))[0]).toMatchObject({
    maxHeight: PREVIEW_CAP,
  });
});

test('inline JSON keeps the windowed FlatList and every row, with no same-axis ScrollView', async () => {
  const renderer = await mount(LARGE_LOG, true);

  // JsonView owns scrolling: the tree is a FlatList, and no ScrollView (which
  // would share the vertical axis with the outer list) wraps it.
  expect(renderer.root.findAllByType(FlatList)).toHaveLength(1);
  expect(ancestorTypes(renderer.root.findByType(JsonView))).not.toContain(ScrollView);

  const list = renderer.root.findByType(FlatList);
  expect(list.props.windowSize).toBe(9);
  expect(list.props.removeClippedSubviews).toBe(true);
  expect(list.props.nestedScrollEnabled).toBe(true);

  const rows = list.props.data as JsonTreeRow[];
  expect(rows.length).toBeGreaterThan(12);
  // The last large-array entry is still part of the flattened tree handed to
  // the virtualized list, so scrolling can reach it.
  expect(rows.some((row) => row.path === 'root.sessions[39]')).toBe(true);
});

test('the full large JSON value reaches JsonView unstringified in both modes', async () => {
  for (const preview of [true, false]) {
    const renderer = await mount(LARGE_LOG, preview);
    const value = renderer.root.findByType(JsonView).props.value as typeof LARGE_JSON;

    expect(value).toEqual(LARGE_JSON);
    expect(value.sessions).toHaveLength(40);
    expect(value.sessions[39]).toEqual(LARGE_JSON.sessions[39]);
  }
});

test('empty and text paths keep their current behavior', async () => {
  for (const log of ['', '   \n\t ', '\n']) {
    for (const preview of [true, false]) {
      const renderer = await mount(log, preview);
      expect(renderer.toJSON()).toBeNull();
    }
  }

  const textLog = 'sessions\n├─ alpha\n└─ beta';
  const inline = await mount(textLog, true);
  const previewScroll = inline.root.findByType(ScrollView);
  expect(maxHeightOf(previewScroll.props.style)).toBe(PREVIEW_CAP);
  expect(inline.root.findAllByType(JsonView)).toHaveLength(0);
  expect(textOf(inline)).toContain('sessions');
  expect(textOf(inline)).toContain('alpha');

  const full = await mount(textLog, false);
  expect(full.root.findAllByType(ScrollView)).toHaveLength(0);
  expect(textOf(full)).toContain('sessions');
  expect(textOf(full)).toContain('beta');
});

test('a failed JSON result keeps its badge in both modes', async () => {
  const failedLog = JSON.stringify({ ok: false, sessions: [{ id: 'sess-0' }] });

  for (const preview of [true, false]) {
    const renderer = await mount(failedLog, preview);
    expect(textOf(renderer)).toContain('✕ ok: false');
    expect(renderer.root.findByType(JsonView)).toBeDefined();
  }

  // The badge sits outside the capped tree, so scrolling rows cannot hide it.
  const inline = await mount(failedLog, true);
  const tree = inline.root.findByType(JsonView);
  expect(tree.parent?.type).toBe('View');
  expect(maxHeightOf(tree.parent?.props.style)).toBe(PREVIEW_CAP);
});
