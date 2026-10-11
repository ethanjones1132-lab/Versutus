/**
 * Saving a provider key ends in a verdict: the Gate's readiness check says the
 * key works, or it names why it does not. The section reloads the provider list
 * right after the save, and that reload used to clear the section error once
 * the list read — so a "not ready" verdict was on screen for a moment and then
 * gone. The reload now lands first and the verdict is set after it.
 */
jest.mock('@/context/gateway-provider', () => ({
  useGateway: () => mockGateway,
}));
// The section's own children are stand-ins whose props ARE its output: the
// ErrorCard's cause is what the operator reads, the key sheet's onSubmit is
// what Save calls.
jest.mock(
  '@/components/ui',
  () =>
    new Proxy(
      {},
      {
        get: (_target, key) => (typeof key === 'string' && key !== '__esModule' ? key : undefined),
      },
    ),
);
// The token module loads reanimated, which has no native side under jest.
jest.mock('@/constants/tokens', () => ({ Spacing: { half: 2, two: 8, three: 12, four: 16 } }));
jest.mock('@/components/gateway/provider-card', () => ({ ProviderCard: 'ProviderCard' }));
jest.mock('@/components/gateway/provider-key-sheet', () => ({ ProviderKeySheet: 'ProviderKeySheet' }));
jest.mock('@/components/gateway/provider-registration-form', () => ({
  ProviderRegistrationForm: 'ProviderRegistrationForm',
}));
jest.mock('@/components/gateway/oauth-progress-sheet', () => ({ OauthProgressSheet: 'OauthProgressSheet' }));

import { createElement, type ElementType } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { ProvidersSection } from '@/components/gateway/providers-section';

const ERROR_CARD = 'ErrorCard' as ElementType;
const CARD = 'ProviderCard' as ElementType;
const KEY_SHEET = 'ProviderKeySheet' as ElementType;

type Snapshot = {
  id: string;
  label: string;
  readiness: { state: string; checkedAt: string; message?: string };
};

const OPENAI_NOT_READY: Snapshot = {
  id: 'openai',
  label: 'OpenAI',
  readiness: { state: 'unavailable', checkedAt: '2026-10-11T00:00:00Z', message: 'key rejected' },
};
const OPENAI_READY: Snapshot = {
  ...OPENAI_NOT_READY,
  readiness: { state: 'ready', checkedAt: '2026-10-11T00:00:00Z' },
};

const mockGateway: { status: string; gatewayRequest: jest.Mock; retryAutoConnect: jest.Mock } = {
  status: 'connected',
  gatewayRequest: jest.fn(),
  retryAutoConnect: jest.fn(),
};

let renderer: ReactTestRenderer | null = null;

/** Let the section's own deferred load and the save chain run to completion. */
async function flush(): Promise<void> {
  for (let round = 0; round < 6; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function find(type: ElementType): ReactTestInstance {
  const found = renderer!.root.findAllByType(type);
  if (found.length === 0) throw new Error(`${String(type)} is not on screen`);
  return found[0];
}

/** The gateway answers each provider call from one table the test controls. */
function answer(answers: Record<string, () => unknown>): void {
  mockGateway.gatewayRequest.mockImplementation(async (method: string) => {
    const reply = answers[method];
    if (!reply) return {};
    return reply();
  });
}

/** Open the key sheet from the provider's own card, then Save a key through it. */
async function saveKey(value: string): Promise<void> {
  await act(async () => {
    (find(CARD).props as { onSetKey: () => void }).onSetKey();
  });
  await act(async () => {
    (find(KEY_SHEET).props as { onSubmit: (value: string) => void }).onSubmit(value);
  });
  await flush();
}

async function mount(): Promise<void> {
  await act(async () => {
    renderer = create(createElement(ProvidersSection));
  });
  await flush();
}

beforeEach(() => {
  mockGateway.status = 'connected';
  mockGateway.gatewayRequest = jest.fn();
  mockGateway.retryAutoConnect = jest.fn();
});

afterEach(async () => {
  if (renderer) {
    const doomed = renderer;
    renderer = null;
    await act(async () => {
      doomed.unmount();
    });
  }
});

describe('saving a provider key keeps its verdict', () => {
  test('a not-ready verdict is still on screen after the reload that follows the save', async () => {
    answer({
      'providers.list': () => ({ providers: [OPENAI_NOT_READY] }),
      'providers.profiles.list': () => ({ profiles: [] }),
      'providers.auth.setApiKey': () => ({ ok: true }),
      'providers.health.check': () => OPENAI_NOT_READY,
    });
    await mount();
    const listCallsBeforeSave = mockGateway.gatewayRequest.mock.calls.filter(
      ([method]) => method === 'providers.list',
    ).length;

    await saveKey('sk-bad');

    // The save really did reload the list, so the verdict had to survive a read.
    const listCalls = mockGateway.gatewayRequest.mock.calls.filter(
      ([method]) => method === 'providers.list',
    ).length;
    expect(listCalls).toBeGreaterThan(listCallsBeforeSave);

    const card = find(ERROR_CARD).props as { cause: string };
    expect(card.cause).toBe('OpenAI: key rejected');
  });

  test('a ready verdict lands as a notice and leaves no error behind', async () => {
    answer({
      'providers.list': () => ({ providers: [OPENAI_READY] }),
      'providers.profiles.list': () => ({ profiles: [] }),
      'providers.auth.setApiKey': () => ({ ok: true }),
      'providers.health.check': () => OPENAI_READY,
    });
    await mount();

    await saveKey('sk-good');

    expect(renderer!.root.findAllByType(ERROR_CARD)).toHaveLength(0);
  });

  test('a reload that fails keeps its own error after a save', async () => {
    let listed = 0;
    answer({
      'providers.list': () => {
        listed += 1;
        if (listed === 1) return { providers: [OPENAI_READY] };
        throw new Error('Gate dropped the list');
      },
      'providers.profiles.list': () => ({ profiles: [] }),
      'providers.auth.setApiKey': () => ({ ok: true }),
      'providers.health.check': () => OPENAI_READY,
    });
    await mount();

    await saveKey('sk-good');

    const card = find(ERROR_CARD).props as { cause: string };
    expect(card.cause).toBe('Gate dropped the list');
  });
});
