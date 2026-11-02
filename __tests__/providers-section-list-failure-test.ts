/**
 * VS-043: a refused `providers.profiles.list` used to render exactly like a
 * Gate that ships no profiles — no error, no Add provider — so the operator
 * could not tell a broken read from an empty Gate, and could not register in
 * either case. The read's outcome now lives beside the list: a genuine refusal
 * is named in the section ErrorCard (with the usual Retry through load()), and
 * Add provider stays reachable because a failed read never proved the Gate has
 * no profiles. An empty answer and a Gate that predates the read still hide it.
 */
jest.mock('@/context/gateway-provider', () => ({
  useGateway: () => mockGateway,
}));
// The section's own children are stand-ins whose props ARE its output: the
// ErrorCard's cause is what the operator reads, the Button's label is what
// they tap.
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
const BUTTON = 'Button' as ElementType;
const EMPTY_STATE = 'EmptyState' as ElementType;

const OPENAI_PROFILE = {
  id: 'openai',
  label: 'OpenAI',
  providerType: 'openai',
  mode: 'api_key' as const,
  protocol: 'openai_chat',
  defaultBaseUrl: 'https://api.openai.com/v1',
  origins: ['https://api.openai.com'],
};

const mockGateway: { status: string; gatewayRequest: jest.Mock; retryAutoConnect: jest.Mock } = {
  status: 'connected',
  gatewayRequest: jest.fn(),
  retryAutoConnect: jest.fn(),
};

let renderer: ReactTestRenderer | null = null;

/** Let the section's own deferred load chain run to completion. */
async function flush(): Promise<void> {
  for (let round = 0; round < 6; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function findAll(type: ElementType): ReactTestInstance[] {
  return renderer!.root.findAllByType(type);
}

function find(type: ElementType): ReactTestInstance {
  const found = findAll(type);
  if (found.length === 0) throw new Error(`${String(type)} is not on screen`);
  return found[0];
}

function findButton(label: string): ReactTestInstance | undefined {
  return findAll(BUTTON).find((node) => (node.props as { label?: string }).label === label);
}

function callsTo(method: string): number {
  return mockGateway.gatewayRequest.mock.calls.filter(([called]) => called === method).length;
}

/** The gateway answers each provider call from one table the test controls. */
function answer(answers: Record<string, () => unknown>): void {
  mockGateway.gatewayRequest.mockImplementation(async (method: string) => {
    const reply = answers[method];
    if (!reply) return {};
    return reply();
  });
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

describe('providers section when the profile list fails', () => {
  test('a rejected read is named in the ErrorCard instead of "no providers yet"', async () => {
    answer({
      'providers.list': () => ({ providers: [] }),
      'providers.profiles.list': () => {
        throw new Error('Gate dropped the profile list');
      },
    });
    await mount();

    const card = find(ERROR_CARD).props as { cause: string; onRetry: () => void };
    expect(card.cause).toBe('Gate dropped the profile list');
    expect(typeof card.onRetry).toBe('function');
    // A broken read is not the empty-Gate claim.
    expect(findAll(EMPTY_STATE)).toHaveLength(0);
  });

  test('a rejected read still leaves Add provider reachable', async () => {
    answer({
      'providers.list': () => ({ providers: [] }),
      'providers.profiles.list': () => {
        throw new Error('Gate dropped the profile list');
      },
    });
    await mount();

    expect(findButton('Add provider')).toBeDefined();
  });

  test('Retry re-reads the profiles and clears the error once the Gate answers', async () => {
    let reads = 0;
    answer({
      'providers.list': () => ({ providers: [] }),
      'providers.profiles.list': () => {
        reads += 1;
        if (reads === 1) throw new Error('Gate dropped the profile list');
        return { profiles: [OPENAI_PROFILE] };
      },
    });
    await mount();
    const readsBeforeRetry = callsTo('providers.profiles.list');
    expect(readsBeforeRetry).toBeGreaterThan(0);

    await act(async () => {
      (find(ERROR_CARD).props as { onRetry: () => void }).onRetry();
    });
    await flush();

    expect(callsTo('providers.profiles.list')).toBeGreaterThan(readsBeforeRetry);
    expect(findAll(ERROR_CARD)).toHaveLength(0);
    expect(findButton('Add provider')).toBeDefined();
  });

  test('a resolved empty list keeps the no-providers state and hides Add provider', async () => {
    answer({
      'providers.list': () => ({ providers: [] }),
      'providers.profiles.list': () => ({ profiles: [] }),
    });
    await mount();

    expect(findAll(ERROR_CARD)).toHaveLength(0);
    const empty = find(EMPTY_STATE).props as { title: string; actionLabel?: string };
    expect(empty.title).toBe('No providers yet');
    expect(empty.actionLabel).toBeUndefined();
    expect(findButton('Add provider')).toBeUndefined();
  });

  test('a Gate that predates the profile read is not treated as a failure', async () => {
    answer({
      'providers.list': () => ({ providers: [] }),
      'providers.profiles.list': () => {
        throw new Error('Unknown method: providers.profiles.list');
      },
    });
    await mount();

    // It still lists, and it still cannot register — but nothing broke.
    expect(findAll(ERROR_CARD)).toHaveLength(0);
    expect(findButton('Add provider')).toBeUndefined();
  });

  test('a disconnected section offers no registration and reads nothing', async () => {
    mockGateway.status = 'disconnected';
    answer({
      'providers.list': () => {
        throw new Error('providers.list should not be read while disconnected');
      },
      'providers.profiles.list': () => ({ profiles: [OPENAI_PROFILE] }),
    });
    await mount();

    const card = find(ERROR_CARD).props as { cause: string };
    expect(card.cause).toBe('Connect to a Gate to manage providers.');
    expect(findButton('Add provider')).toBeUndefined();
    expect(callsTo('providers.list')).toBe(0);
    expect(callsTo('providers.profiles.list')).toBe(0);
  });
});
