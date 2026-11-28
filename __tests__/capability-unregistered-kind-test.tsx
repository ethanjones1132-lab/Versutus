// ─── An instance whose kind is not in the registry cannot be silently dead ───
// `startEdit` used to set a draft even when `kinds` had no entry for the
// instance, but the editor renders only when `draft && selectedKind` — so the
// tap kept the list on screen and said nothing. The contract here: the tap
// names the missing kind and the list does not pretend an editor opened.

import { createElement, type ElementType } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { CapabilitiesSection } from '@/components/gateway/capabilities-section';
import type { GatewayCapabilityKind } from '@/lib/portal/manifest';

jest.mock('@/components/ui', () => ({
  Button: 'Button',
  Card: 'Card',
  ConfirmSheet: 'ConfirmSheet',
  Skeleton: 'Skeleton',
  Text: 'Text',
  TextField: 'TextField',
}));

jest.mock('react-native-reanimated', () => ({
  Easing: {
    bezier: () => (value: number) => value,
    elastic: () => (value: number) => value,
  },
}));

const mockGatewayRequest = jest.fn();
const mockRefreshCapabilities = jest.fn();

const mockGateway = {
  status: 'connected',
  gatewayRequest: (method: string, params?: Record<string, unknown>) =>
    mockGatewayRequest(method, params),
  refreshCapabilities: () => mockRefreshCapabilities(),
};

jest.mock('@/context/gateway-provider', () => ({
  useGateway: () => mockGateway,
}));

const BUTTON = 'Button' as ElementType;

const KIND: GatewayCapabilityKind = {
  id: 'pacer',
  label: 'Pacer',
  family: 'scheduling',
  configFields: [{ key: 'limit', label: 'Request limit', type: 'number' }],
};

const INSTANCES = [
  { id: 'live', kind: 'pacer', label: 'Live Pacer', config: { limit: 5 } },
  { id: 'ghost', kind: 'retired-kind', label: 'Ghost', config: {} },
];

let renderer: ReactTestRenderer;

async function mount(): Promise<void> {
  await act(async () => {
    renderer = create(createElement(CapabilitiesSection));
  });
  // the section defers its first read by a macrotask; let it land.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
  });
}

function shown(): string {
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

function labels(): string[] {
  return renderer.root.findAllByType(BUTTON).map((node) => String(node.props.label));
}

async function pressInstance(label: string): Promise<void> {
  const row = renderer.root
    .findAll((node) => typeof node.props?.onPress === 'function')
    .find((node) => node.findAll((child) => child.props?.children === label).length > 0);
  expect(row).toBeDefined();
  await act(async () => {
    row?.props.onPress();
  });
}

beforeEach(() => {
  mockGatewayRequest.mockReset();
  mockRefreshCapabilities.mockReset();
  mockGatewayRequest.mockImplementation(async (method: string) => {
    if (method === 'registry.kinds.list') return [KIND];
    if (method === 'registry.instances.list') return INSTANCES;
    return {};
  });
  mockRefreshCapabilities.mockResolvedValue(undefined);
});

afterEach(async () => {
  if (renderer) {
    const doomed = renderer;
    renderer = undefined as unknown as ReactTestRenderer;
    await act(async () => {
      doomed.unmount();
    });
  }
  jest.clearAllMocks();
});

test('tapping an instance whose kind is missing names the kind and opens no editor', async () => {
  await mount();
  await pressInstance('Ghost');

  expect(shown()).toContain('"retired-kind" kind is not available from this gateway');
  expect(shown()).toContain('"Ghost" cannot be edited here');
  // No editor card: a draft that never renders is exactly the silent failure.
  expect(labels()).not.toContain('Save');
  expect(labels()).toContain('Add Pacer');
});

test('a later tap on a known kind clears the message and opens its editor', async () => {
  await mount();
  await pressInstance('Ghost');
  expect(shown()).toContain('is not available from this gateway');

  await pressInstance('Live Pacer');
  expect(shown()).not.toContain('is not available from this gateway');
  // The editor for the found kind is on screen: its own field label renders
  // only inside the draft card.
  expect(shown()).toContain('Request limit');
  expect(labels()).toContain('Save');
});
