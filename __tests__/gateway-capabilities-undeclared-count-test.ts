import { createElement, type ElementType } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { GatewayCapabilities } from '@/components/gateway/gateway-capabilities';
import type { GatewayCapabilitySnapshot } from '@/lib/gateway/types';

jest.mock('@/constants/tokens', () => ({
  Palette: { border: '#000', textPrimary: '#000', textSecondary: '#555' },
  Radius: { sm: 4, md: 8 },
  Spacing: { half: 2, one: 4, two: 8, three: 12 },
}));
jest.mock('@/components/ui', () => ({ Card: 'Card', Text: 'Text' }));
jest.mock('@/hooks/use-now', () => ({ useNow: () => 100 }));
jest.mock('@/hooks/use-tokens', () => ({
  useTokens: () => ({
    statusConnected: '#0f0',
    statusConnecting: '#fa0',
    statusDisconnected: '#f00',
    accent: '#00f',
    textTertiary: '#999',
    border: '#ccc',
    backgroundInset: '#eee',
  }),
}));

const TEXT = 'Text' as ElementType;

function textOf(node: ReactTestInstance): string {
  const children = node.props.children;
  const parts = Array.isArray(children) ? children : [children];
  return parts
    .map((child) => (typeof child === 'string' || typeof child === 'number' ? String(child) : ''))
    .join('');
}

// Two undeclared groups are not capabilities this gateway lacks. Before the
// fix the toggle read `groups.length - visible.length`, so it advertised the
// undeclared groups as "not offered" (3 hidden) even though only one counted
// group was hidden, and expanding the toggle revealed the undeclared pills.
// The count must come from `counted` so the number matches the tap.
const snapshot: GatewayCapabilitySnapshot = {
  checkedAt: 100,
  status: 'fresh',
  methods: {},
  scopes: [],
  groups: [
    { id: 'chat', label: 'Chat', status: 'ready', availableCount: 1, totalCount: 1 },
    { id: 'voice', label: 'Voice', status: 'unsupported', note: 'not offered' },
    { id: 'future-a', label: 'Future A', status: 'undeclared' },
    { id: 'future-b', label: 'Future B', status: 'undeclared' },
  ],
};

describe('the not-offered count and the list it expands to exclude undeclared groups', () => {
  let renderer!: ReactTestRenderer;

  afterEach(async () => {
    await act(async () => {
      renderer.unmount();
    });
  });

  test('the toggle names the one counted group it hides, never the undeclared ones', async () => {
    await act(async () => {
      renderer = create(createElement(GatewayCapabilities, { snapshot }));
    });

    const labels = () => renderer.root.findAllByType(TEXT).map(textOf);

    // The declared ratio still counts only the two declared groups.
    expect(labels()).toContain('1/2 ready');
    // Only `voice` is a counted group that is not offered; the two undeclared
    // groups must not inflate the number (a revert reads "Show 3 not offered").
    expect(labels()).toContain('Show 1 not offered');

    // RN's `Pressable` is a memo/forwardRef, so `findAllByType(Pressable)`
    // matches nothing in the renderer. Find the toggle by the props it
    // declares: the Show-all button, announced as "Show all capabilities"
    // while collapsed (gateway-capabilities.tsx:50-52).
    const toggle = renderer.root.findAll(
      (node) =>
        node.props?.accessibilityRole === 'button' &&
        node.props?.accessibilityLabel === 'Show all capabilities' &&
        typeof node.props?.onPress === 'function',
    )[0];
    expect(toggle).toBeDefined();
    await act(async () => {
      toggle.props.onPress();
    });

    const expanded = labels();
    expect(expanded).toContain('Hide unsupported');
    // Expanding shows the counted groups only — an undeclared group is not a
    // capability this gateway lacks, so it never appears as a pill.
    expect(expanded).not.toContain('Future A');
    expect(expanded).not.toContain('Future B');
  });
});
