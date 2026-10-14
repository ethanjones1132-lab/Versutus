// ─── A deep link's address is confirmed before the add sheet sends anything ──
// `versutus://add?url=…&token=…` can be opened by any app or web page that can
// fire the custom scheme (README's pairing-link form). The sheet used to take
// that URL and token straight into its form values, so one tap on "Save &
// connect" sent this device's identity — and the link's bearer token — to a
// host the link chose, before the operator had looked at the address. What a
// link fills in is a request, not a decision: the screen now shows Save only
// after an explicit confirmation that names the address, and only the
// operator's own edit of the URL counts as consent for a different one.
//
// These drive the real screen with the link's params, the way the deep-link
// router pushes them (`router.push({ pathname: '/gateway/add', params })`).

const mockParams: {
  url?: string;
  token?: string;
  name?: string;
  sessionKey?: string;
  agentId?: string;
} = {};

const mockAddGateway = jest.fn(async () => ({ id: 'gw-1' }));
const mockConnectGateway = jest.fn(async () => undefined);

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
}));

jest.mock('@/context/gateway-provider', () => ({
  useGateway: () => ({ addGateway: mockAddGateway, connectGateway: mockConnectGateway }),
}));

// device-identity reaches storage through this module; the screen under these
// cases never touches a stored secret, but the module graph still loads it.
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
  removeItem: jest.fn(async () => undefined),
  getAllKeys: jest.fn(async () => []),
  multiRemove: jest.fn(async () => undefined),
}));

// tokens.ts only needs Easing for Motion curves; reanimated's native worklet
// unpackers cannot load under jest-expo.
jest.mock('react-native-reanimated', () => ({
  Easing: {
    bezier: () => (value: number) => value,
    elastic: () => (value: number) => value,
  },
}));

// The screen's primitives keep their props, which is how a disabled Save and
// the confirmation control are observed.
jest.mock('@/components/ui', () => ({
  Badge: 'Badge',
  Button: 'Button',
  Card: 'Card',
  ErrorCard: 'ErrorCard',
  Icon: 'Icon',
  Screen: 'Screen',
  Text: 'Text',
  TextField: 'TextField',
}));

import { createElement, type ElementType } from 'react';
import { ScrollView } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import AddGatewayScreen from '@/app/gateway/add';

const BUTTON = 'Button' as ElementType;
const TEXT_FIELD = 'TextField' as ElementType;

/** The address a link is handing the sheet. */
const LINK_URL = 'https://linked.example:8443';

let renderer: ReactTestRenderer;

// React Native's first render in a process lazily loads its own internals:
// pay it here, at module scope, where no per-test clock is running (the house
// rule from spend-bot-wave-test).
act(() => {
  create(createElement(ScrollView)).unmount();
});

function button(label: string) {
  return renderer.root.findAllByType(BUTTON).find((node) => node.props.label === label);
}

function confirm() {
  return button('Use this address');
}

/** The gateway URL field: the only field carrying a URL placeholder. */
function urlField() {
  return renderer.root
    .findAllByType(TEXT_FIELD)
    .find((node) => String(node.props.placeholder ?? '').includes('ts.net'));
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

async function mount(params: Record<string, string> = {}): Promise<void> {
  for (const key of Object.keys(mockParams)) delete (mockParams as Record<string, unknown>)[key];
  Object.assign(mockParams, params);
  await act(async () => {
    renderer = create(createElement(AddGatewayScreen));
  });
}

async function press(label: string): Promise<void> {
  const target = button(label);
  expect(target).toBeDefined();
  await act(async () => {
    target?.props.onPress();
  });
}

async function typeUrl(value: string): Promise<void> {
  const field = urlField();
  expect(field).toBeDefined();
  await act(async () => {
    field?.props.onChangeText(value);
  });
}

beforeEach(() => {
  mockAddGateway.mockClear();
  mockConnectGateway.mockClear();
});

afterEach(async () => {
  if (renderer) {
    const doomed = renderer;
    renderer = undefined as unknown as ReactTestRenderer;
    await act(async () => {
      doomed.unmount();
    });
  }
});

test('a link address is named on screen and Save is held until it is confirmed', async () => {
  await mount({ url: LINK_URL, token: 'link-token', name: 'Linked' });

  // The address the link asks to reach is the one shown for confirmation.
  expect(shown()).toContain('linked.example:8443');
  expect(confirm()).toBeDefined();

  // Nothing can leave the device: there is no Save control at all, even though
  // the URL and token are already filled in from the link.
  expect(button('Save & connect')).toBeUndefined();
  expect(mockAddGateway).not.toHaveBeenCalled();
  expect(mockConnectGateway).not.toHaveBeenCalled();
});

test('confirming the address arms Save without sending anything by itself', async () => {
  await mount({ url: LINK_URL, token: 'link-token', name: 'Linked' });

  await press('Use this address');

  const save = button('Save & connect');
  expect(save).toBeDefined();
  expect(save?.props.disabled).toBe(false);
  expect(confirm()).toBeUndefined();
  // Confirmation is consent to save, not a save: the handshake still waits for
  // the operator's own tap on Save & connect.
  expect(mockAddGateway).not.toHaveBeenCalled();
  expect(mockConnectGateway).not.toHaveBeenCalled();
});

test("an address the operator types is the operator's own decision, not the link's", async () => {
  await mount({ url: LINK_URL });

  await typeUrl('https://mine.example:8642');

  // The link's address is gone from the field, so there is nothing left to
  // confirm: the typed host is not the untrusted one.
  expect(button('Save & connect')?.props.disabled).toBe(false);
  expect(confirm()).toBeUndefined();
});

test('an add sheet opened without a link still saves in one step', async () => {
  await mount({});

  expect(confirm()).toBeUndefined();
  expect(button('Save & connect')?.props.disabled).toBe(true);

  await typeUrl('http://home.example:8642');

  expect(button('Save & connect')?.props.disabled).toBe(false);
  expect(confirm()).toBeUndefined();
});
