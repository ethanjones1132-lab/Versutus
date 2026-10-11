// ─── A capability number field cannot save a value the operator did not type ──
// `parseFieldValue` turned an empty or junk number into 0, so clearing a field
// or typing "12a" saved 0 to the Gate without a word. The contract these tests
// pin: junk is refused before any RPC and names the field, an empty optional
// number is left out of the config, and a typed number is saved as typed.

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
const TEXT_FIELD = 'TextField' as ElementType;

const KIND: GatewayCapabilityKind = {
  id: 'pacer',
  label: 'Pacer',
  family: 'scheduling',
  configFields: [
    { key: 'limit', label: 'Request limit', type: 'number', help: 'max requests' },
  ],
};

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

async function press(label: string): Promise<void> {
  const button = renderer.root
    .findAllByType(BUTTON)
    .find((candidate) => candidate.props.label === label);
  expect(button).toBeDefined();
  await act(async () => {
    button?.props.onPress();
  });
}

async function fill(placeholder: string, value: string): Promise<void> {
  const field = renderer.root
    .findAllByType(TEXT_FIELD)
    .find((candidate) => candidate.props.placeholder === placeholder);
  expect(field).toBeDefined();
  await act(async () => {
    field?.props.onChangeText(value);
  });
}

/** Opens a create draft and types the limit, then presses Save. */
async function saveWithLimit(limit: string): Promise<void> {
  await press('Add Pacer');
  await fill('instance-id', 'x');
  await fill('Label', 'X');
  await fill('max requests', limit);
  await press('Save');
}

function methods(): string[] {
  return mockGatewayRequest.mock.calls.map((call) => String(call[0]));
}

function createdConfig(): Record<string, unknown> {
  const call = mockGatewayRequest.mock.calls.find(
    (entry) => entry[0] === 'registry.instances.create',
  );
  expect(call).toBeDefined();
  return (call?.[1] as { config: Record<string, unknown> }).config;
}

beforeEach(() => {
  mockGatewayRequest.mockReset();
  mockRefreshCapabilities.mockReset();
  mockGatewayRequest.mockImplementation(async (method: string) => {
    if (method === 'registry.kinds.list') return [KIND];
    if (method === 'registry.instances.list') return [];
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

test('a number typed as "12a" is refused before any RPC, naming the field', async () => {
  await mount();
  await saveWithLimit('12a');

  expect(methods()).toEqual(['registry.kinds.list', 'registry.instances.list']);
  expect(shown()).toContain('Request limit');
  expect(shown()).toContain('must be a number');
  // the draft stays open so the value can be corrected
  expect(labels()).toContain('Save');
});

test('an optional number cleared to empty is left out of the config, not saved as 0', async () => {
  await mount();
  await saveWithLimit('');

  expect(countOf('registry.instances.create')).toBe(1);
  expect(createdConfig()).not.toHaveProperty('limit');
});

test('a number typed as "42" is saved as 42', async () => {
  await mount();
  await saveWithLimit('42');

  expect(createdConfig()).toEqual({ limit: 42 });
});

function countOf(method: string): number {
  return methods().filter((name) => name === method).length;
}
