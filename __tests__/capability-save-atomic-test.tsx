// ─── A capability save cannot half-complete ─────────────────────────────────
// `saveDraft` created the instance FIRST and set the secret second, and its
// pre-flight check only mirrored the Gate's credential-SHAPE guard. The Gate
// also refuses a ref under the `provider/` namespace
// (gate/core/capabilities/registry-methods.mjs), so `provider/my/api-key` —
// a shape the CLI-environment form teaches — created the instance, refused the
// secret, showed the error and left the draft open in create mode. Every retry
// then hit `instance "x" already exists`, so the draft could never complete and
// the Gate kept an instance pointing at a secret that was never set.
//
// The contract these tests pin: a `provider/` ref is refused before any RPC;
// the secret is sent before the instance; a refused secret leaves no instance
// and a corrected retry completes; a save that landed but could not refresh
// closes the draft instead of dead-ending on "already exists".

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

// A stable gateway object: the real provider memoizes its callbacks, and the
// section's `load` is a useCallback over `gatewayRequest`.
const mockGateway = {
  status: 'connected',
  gatewayRequest: (method: string, params?: Record<string, unknown>) =>
    mockGatewayRequest(method, params),
  refreshCapabilities: () => mockRefreshCapabilities(),
};

jest.mock('@/context/gateway-provider', () => ({
  useGateway: () => mockGateway,
}));

import { createElement, type ElementType } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { CapabilitiesSection } from '@/components/gateway/capabilities-section';
import { isProviderCredentialRef, looksLikeCredential } from '@/lib/gateway/credential-shape';
import type { GatewayCapabilityKind } from '@/lib/portal/manifest';

const BUTTON = 'Button' as ElementType;
const TEXT_FIELD = 'TextField' as ElementType;

const KIND: GatewayCapabilityKind = {
  id: 'channel',
  label: 'Channel',
  family: 'messaging',
  configFields: [
    { key: 'secretRef', label: 'Secret ref', type: 'secret-ref', help: 'name of the secret' },
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

function labels(): string[] {
  return renderer.root.findAllByType(BUTTON).map((node) => String(node.props.label));
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

async function openDraft(): Promise<void> {
  await press('Add Channel');
}

async function save(refName: string, secretValue: string): Promise<void> {
  await openDraft();
  await fill('instance-id', 'x');
  await fill('Label', 'X');
  await fill('name of the secret', refName);
  await fill('paste secret', secretValue);
  await press('Save');
}

/** Every RPC method name the section sent, in order. */
function methods(): string[] {
  return mockGatewayRequest.mock.calls.map((call) => String(call[0]));
}

function countOf(method: string): number {
  return methods().filter((name) => name === method).length;
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

test('isProviderCredentialRef mirrors the Gate namespace guard', () => {
  expect(isProviderCredentialRef('provider/my-provider/api-key')).toBe(true);
  expect(isProviderCredentialRef('  provider/anthropic-main/api-key  ')).toBe(true);
  expect(isProviderCredentialRef('my-api-key')).toBe(false);
  expect(isProviderCredentialRef('')).toBe(false);
  expect(isProviderCredentialRef(undefined)).toBe(false);
  // the credential-shape guard is unchanged and still orthogonal
  expect(looksLikeCredential('provider/my-provider/api-key')).toBe(false);
  expect(looksLikeCredential('sk-live-abc')).toBe(true);
});

test('a provider/ secret ref is refused before any RPC names the field and the screen', async () => {
  await mount();
  await save('provider/my-provider/api-key', 'sk-live-abc');

  expect(methods()).toEqual(['registry.kinds.list', 'registry.instances.list']);
  const refusal = shown();
  expect(refusal).toContain('Secret ref');
  expect(refusal).toContain('provider/my-provider/api-key');
  expect(refusal).toContain('providers.auth.setApiKey');
  expect(refusal).toContain('Providers');
  // the draft stays open so a corrected ref has somewhere to go
  expect(labels()).toContain('Save');
});

test('a refused secret creates no instance, and a corrected retry completes', async () => {
  let refuseSecret = true;
  mockGatewayRequest.mockImplementation(async (method: string) => {
    if (method === 'registry.kinds.list') return [KIND];
    if (method === 'registry.instances.list') return [];
    if (method === 'registry.secrets.set' && refuseSecret) {
      throw new Error('"my-api-key" is not writable on this Gate.');
    }
    return {};
  });

  await mount();
  await save('my-api-key', 'sk-live-abc');

  expect(countOf('registry.secrets.set')).toBe(1);
  // the instance write never happened, so the draft can still complete
  expect(countOf('registry.instances.create')).toBe(0);
  expect(shown()).toContain('is not writable on this Gate');
  expect(labels()).toContain('Save');

  refuseSecret = false;
  await press('Save');

  expect(countOf('registry.instances.create')).toBe(1);
  expect(methods().indexOf('registry.secrets.set')).toBeLessThan(
    methods().indexOf('registry.instances.create'),
  );
  expect(labels()).not.toContain('Save');
});

test('the secret is sent before the instance it configures', async () => {
  await mount();
  await save('my-api-key', 'sk-live-abc');

  expect(methods()).toContain('registry.secrets.set');
  expect(methods().indexOf('registry.secrets.set')).toBeLessThan(
    methods().indexOf('registry.instances.create'),
  );
});

test('a create refused for another reason keeps the draft open and names the reason', async () => {
  mockGatewayRequest.mockImplementation(async (method: string) => {
    if (method === 'registry.kinds.list') return [KIND];
    if (method === 'registry.instances.list') return [];
    if (method === 'registry.instances.create') throw new Error('unknown kind "channel"');
    return {};
  });

  await mount();
  await save('my-api-key', 'sk-live-abc');

  expect(countOf('registry.secrets.set')).toBe(1);
  expect(shown()).toContain('unknown kind "channel"');
  expect(labels()).toContain('Save');
});

test('a create that lands on an existing id finishes as an update', async () => {
  mockGatewayRequest.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'registry.kinds.list') return [KIND];
    if (method === 'registry.instances.list') return [];
    if (method === 'registry.instances.create') throw new Error('instance "x" already exists');
    if (method === 'registry.instances.update') return { id: params?.id };
    return {};
  });

  await mount();
  await save('my-api-key', 'sk-live-abc');

  expect(countOf('registry.instances.update')).toBe(1);
  expect(labels()).not.toContain('Save');
  expect(shown()).not.toContain('already exists');
});

test('a save that landed but could not refresh closes the draft and says so', async () => {
  mockRefreshCapabilities.mockRejectedValue(new Error('Gateway not connected'));

  await mount();
  await save('my-api-key', 'sk-live-abc');

  expect(countOf('registry.instances.create')).toBe(1);
  // the draft is closed: a retry would hit "already exists" for a saved instance
  expect(labels()).not.toContain('Save');
  expect(labels()).toContain('Add Channel');
  // the refusal is reported as a refresh failure, not as a failed save
  expect(shown()).toContain('could not be refreshed');
  expect(shown()).toContain('Gateway not connected');
});

test('a delete affordance still renders for a configured instance', async () => {
  mockGatewayRequest.mockImplementation(async (method: string) => {
    if (method === 'registry.kinds.list') return [KIND];
    if (method === 'registry.instances.list') {
      return [{ id: 'x', kind: 'channel', label: 'X', config: {} }];
    }
    return {};
  });

  await mount();
  expect(countOf('registry.kinds.list')).toBe(1);
  expect(shown()).toContain('X');
  expect(labels()).toContain('Delete');
});
