import { effectiveModel, resolveSendModel, withSelectedModel,
  shouldReleaseSessionForModel, applyModelOverride,
  sameModelId, flattenHermesModelOptions, modelPickerName,
  staleModelPin,
} from '@/lib/gateway/model-selection';
import type { GatewayProfile } from '@/lib/gateway/types';

const BASE: GatewayProfile = {
  id: 'g1',
  name: 'Gate',
  url: 'http://127.0.0.1:8760',
  createdAt: 0,
  model: 'gateway-default',
};

describe('effectiveModel', () => {
  it('prefers the model remembered for the active backend', () => {
    const profile = { ...BASE, backendModels: { 'codex-local': 'gpt-5.5' } };
    expect(effectiveModel(profile, 'codex-local')).toBe('gpt-5.5');
  });

  it('leaves the model unpinned when the selected backend has no memory', () => {
    const profile = { ...BASE, backendModels: { 'codex-local': 'gpt-5.5' } };
    expect(effectiveModel(profile, 'opencode-local')).toBeUndefined();
  });

  it('falls back when no backend is selected', () => {
    expect(effectiveModel(BASE, undefined)).toBe('gateway-default');
  });

  it('leaves a backend unpinned on a profile saved before backendModels existed', () => {
    expect(effectiveModel(BASE, 'codex-local')).toBeUndefined();
  });
});

describe('withSelectedModel', () => {
  it('remembers the model against the active backend', () => {
    const next = withSelectedModel(BASE, 'gpt-5.5', 'codex-local');
    expect(next.backendModels).toEqual({ 'codex-local': 'gpt-5.5' });
  });

  it('also sets the profile model so every send path stays correct', () => {
    const next = withSelectedModel(BASE, 'gpt-5.5', 'codex-local');
    expect(next.model).toBe('gpt-5.5');
  });

  it('does not disturb another backend memory', () => {
    const profile = { ...BASE, backendModels: { 'opencode-local': 'claude-sonnet' } };
    const next = withSelectedModel(profile, 'gpt-5.5', 'codex-local');
    expect(next.backendModels).toEqual({
      'opencode-local': 'claude-sonnet',
      'codex-local': 'gpt-5.5',
    });
  });

  it('writes only the profile model when no backend is selected', () => {
    const next = withSelectedModel(BASE, 'grok-4', undefined);
    expect(next.model).toBe('grok-4');
    expect(next.backendModels).toBeUndefined();
  });
});

describe('bot-scoped model', () => {
  it('a Bot with no explicit pick carries no model, so its own profile answers', () => {
    // anvil is grok-4.6 and ledger is a deepseek on nvidia, configured in
    // Hermes. Sending the configurable-chat model for an unpicked Bot would
    // pin the new session to it and quietly swap the Bot's identity — the
    // failure mode that put an unrequested NVIDIA model on a fresh thread.
    const profile = {
      ...BASE,
      model: 'gateway-default',
      backendModels: { 'hermes-local': 'hermes-default' },
      botModels: {},
    };
    expect(effectiveModel(profile, 'hermes-local', 'anvil')).toBeUndefined();
    expect(resolveSendModel(profile, 'hermes-local', 'anvil')).toEqual({});
  });

  it('an explicit pick for one Bot does not leak to another', () => {
    const profile = {
      ...BASE,
      model: 'gateway-default',
      botModels: { anvil: 'xai/grok-4.6' },
    };
    expect(effectiveModel(profile, 'hermes-local', 'anvil')).toBe('xai/grok-4.6');
    expect(effectiveModel(profile, 'hermes-local', 'ledger')).toBeUndefined();
  });

  it('prefers botModels when a bot is selected', () => {
    const profile = {
      ...BASE,
      model: 'gateway-default',
      backendModels: { 'hermes-local': 'hermes-default' },
      botModels: { researcher: 'anthropic/claude-opus' },
    };
    expect(effectiveModel(profile, 'hermes-local', 'researcher')).toBe('anthropic/claude-opus');
  });

  it('does not use botModels for configurable chat', () => {
    const profile = {
      ...BASE,
      backendModels: { 'hermes-local': 'hermes-default' },
      botModels: { researcher: 'anthropic/claude-opus' },
    };
    expect(effectiveModel(profile, 'hermes-local', undefined)).toBe('hermes-default');
  });

  it('withSelectedModel for a bot writes only botModels', () => {
    const next = withSelectedModel(BASE, 'x-ai/grok-4', 'hermes-local', 'researcher');
    expect(next.botModels).toEqual({ researcher: 'x-ai/grok-4' });
    expect(next.model).toBe('gateway-default');
    expect(next.backendModels).toBeUndefined();
  });

  it('withSelectedModel without a bot still writes backendModels and model', () => {
    const next = withSelectedModel(BASE, 'gpt-5.5', 'codex-local');
    expect(next.model).toBe('gpt-5.5');
    expect(next.backendModels).toEqual({ 'codex-local': 'gpt-5.5' });
    expect(next.botModels).toBeUndefined();
  });

  it('resolveSendModel uses the bot pick when selected', () => {
    const profile = { ...BASE, botModels: { researcher: 'x-ai/grok-4' }, model: 'other' };
    expect(resolveSendModel(profile, 'hermes-local', 'researcher')).toEqual({ model: 'x-ai/grok-4' });
    expect(resolveSendModel(profile, undefined, undefined)).toEqual({ model: 'other' });
  });
});

test('changing model releases the thread, because a session cannot change its own', () => {
  // Hermes fixes a session's model at creation — PATCH /api/sessions/{id}
  // refuses `model` outright — so a pick made mid-thread could never take
  // effect on that thread. Releasing the session is what makes the picker
  // mean something; the next send opens a fresh one pinned to the choice.
  expect(shouldReleaseSessionForModel({ previous: 'longcat-2.0', next: 'kimi-k3', hasSession: true })).toBe(true);
});

test('re-picking the model already in use never throws the thread away', () => {
  expect(shouldReleaseSessionForModel({ previous: 'kimi-k3', next: 'kimi-k3', hasSession: true })).toBe(false);
  // Whitespace and case are not a change worth resetting a conversation for.
  expect(shouldReleaseSessionForModel({ previous: ' kimi-k3 ', next: 'Kimi-K3', hasSession: true })).toBe(false);
});

test('with no session open there is nothing to release', () => {
  expect(shouldReleaseSessionForModel({ previous: 'longcat-2.0', next: 'kimi-k3', hasSession: false })).toBe(false);
});

test('a first pick on a thread with no model yet releases the session', () => {
  // REVERSED 2026-09-07. This previously asserted false, on the theory that an
  // unpinned thread is already running the gateway's default so a first pick
  // changes nothing. Device use disproved it: `effectiveModel` is undefined
  // whenever no override is stored, so the app cannot know what the host
  // opened the session with — the operator picked a model, the session kept
  // answering as something else, and the turn came back empty. An unknown
  // previous now means "not proven to be `next`", and the pick takes effect.
  expect(shouldReleaseSessionForModel({ next: 'kimi-k3', hasSession: true })).toBe(true);
});

test('a first pick still keeps the thread when there is no session to release', () => {
  expect(shouldReleaseSessionForModel({ next: 'kimi-k3', hasSession: false })).toBe(false);
});

test('an empty pick is never a reason to throw the thread away', () => {
  expect(shouldReleaseSessionForModel({ previous: 'kimi-k3', next: '   ', hasSession: true })).toBe(false);
});

test('two names for the same model do not release the session', () => {
  // Same rule canServeModel applies: the app carries `providerId/modelId`
  // while a session records whichever form its creator used. A raw compare
  // would throw away a thread that was already answering on the right model.
  expect(shouldReleaseSessionForModel({ previous: 'openai/gpt-5', next: 'gpt-5', hasSession: true })).toBe(false);
  expect(shouldReleaseSessionForModel({ previous: 'gpt-5', next: 'openai/gpt-5', hasSession: true })).toBe(false);
});

test('a genuinely different model still releases when both names are qualified', () => {
  expect(shouldReleaseSessionForModel({ previous: 'openai/gpt-5', next: 'moonshot/kimi-k3', hasSession: true })).toBe(true);
});

describe('applyModelOverride', () => {
  it('a slash override on Bot Chat writes only the Bot pin and releases the open session', () => {
    const profile = {
      ...BASE,
      model: 'gateway-default',
      backendModels: { 'hermes-local': 'hermes-default' },
      botModels: { researcher: 'longcat-2.0' },
    };
    const next = applyModelOverride({
      gateway: profile,
      modelId: 'kimi-k3',
      selectedBackendId: 'hermes-local',
      selectedBotId: 'researcher',
      hasSession: true,
    });
    expect(next.gateway.model).toBe('gateway-default');
    expect(next.gateway.backendModels).toEqual({ 'hermes-local': 'hermes-default' });
    expect(next.gateway.botModels).toEqual({ researcher: 'kimi-k3' });
    expect(next.releaseSession).toBe(true);
  });

  it('a slash override in configurable chat writes the gateway pin, not a Bot pin', () => {
    const next = applyModelOverride({
      gateway: BASE,
      modelId: 'kimi-k3',
      selectedBackendId: 'hermes-local',
      hasSession: true,
    });
    expect(next.gateway.model).toBe('kimi-k3');
    expect(next.gateway.backendModels).toEqual({ 'hermes-local': 'kimi-k3' });
    expect(next.gateway.botModels).toBeUndefined();
    // REVERSED 2026-09-07, same reason as shouldReleaseSessionForModel's own
    // first-pick case: no remembered model for the backend means the app
    // cannot know what the open session is actually serving, so a first
    // explicit pick MUST release it or the pick never reaches the wire.
    expect(next.releaseSession).toBe(true);
  });

  it('does not throw the thread away when the Bot is already on that model', () => {
    const profile = { ...BASE, botModels: { researcher: 'kimi-k3' } };
    const next = applyModelOverride({
      gateway: profile,
      modelId: 'kimi-k3',
      selectedBackendId: 'hermes-local',
      selectedBotId: 'researcher',
      hasSession: true,
    });
    expect(next.releaseSession).toBe(false);
    expect(next.gateway.botModels).toEqual({ researcher: 'kimi-k3' });
  });
});

describe('sameModelId', () => {
  it('treats a provider prefix as the same model, including a nested vendor id', () => {
    expect(sameModelId('nous/poolside/laguna-xs-2.1:free', 'poolside/laguna-xs-2.1:free')).toBe(true);
    expect(sameModelId('opencode-zen/laguna-s-2.1-free', 'laguna-s-2.1-free')).toBe(true);
    expect(sameModelId('laguna-s-2.1-free', 'opencode-zen/laguna-s-2.1-free')).toBe(true);
  });

  it('does not collapse two different models that share a suffix fragment', () => {
    expect(sameModelId('dots-studio/dots-3-note-preview:free', 'opencode-zen/laguna-s-2.1-free')).toBe(false);
    expect(sameModelId('poolside/laguna-xs-2.1:free', 'poolside/laguna-s-2.1:free')).toBe(false);
  });
});

describe('modelPickerName', () => {
  it('shows only the model token under a provider section, not the full slug', () => {
    expect(
      modelPickerName({
        id: 'nous/poolside/laguna-xs-2.1:free',
        modelId: 'poolside/laguna-xs-2.1:free',
        providerId: 'nous',
      }),
    ).toBe('laguna-xs-2.1:free');
    expect(
      modelPickerName({ id: 'opencode-zen/laguna-s-2.1-free', providerId: 'opencode-zen' }),
    ).toBe('laguna-s-2.1-free');
    expect(modelPickerName({ id: 'gpt-5.5', providerId: 'openai' })).toBe('gpt-5.5');
  });
});

describe('staleModelPin', () => {
  const CATALOG = [
    { id: 'nous/poolside/laguna-xs-2.1:free', available: false },
    { id: 'xai/grok-4.6', available: true },
    { id: 'nvidia/deepseek-v3' },
  ];

  it('condemns a pin whose catalog row reports the provider signed out', () => {
    // The pin was written while Nous Portal was signed in; the login is gone
    // now and the row stays visible but locked. Sending to it is the dead
    // turn — "completed with no assistant content".
    expect(staleModelPin(CATALOG, 'nous/poolside/laguna-xs-2.1:free')).toEqual({
      pinned: 'nous/poolside/laguna-xs-2.1:free',
      fallback: 'xai/grok-4.6',
    });
  });

  it('matches a pin that dropped the provider prefix', () => {
    expect(staleModelPin(CATALOG, 'poolside/laguna-xs-2.1:free')?.fallback).toBe('xai/grok-4.6');
  });

  it('keeps a pin whose provider is still signed in — a normal reconnect changes nothing', () => {
    expect(staleModelPin(CATALOG, 'xai/grok-4.6')).toBeNull();
  });

  it('treats a row with no availability signal as available (older gateways predate the field)', () => {
    expect(staleModelPin(CATALOG, 'nvidia/deepseek-v3')).toBeNull();
  });

  it('keeps a pin the catalog does not list — an incomplete catalog proves nothing', () => {
    expect(staleModelPin(CATALOG, 'openai/gpt-5.5')).toBeNull();
    expect(staleModelPin([], 'xai/grok-4.6')).toBeNull();
  });

  it('has nothing to validate when no model is pinned', () => {
    expect(staleModelPin(CATALOG, undefined)).toBeNull();
  });

  it('reports no fallback when every other row is locked too', () => {
    const allLocked = [
      { id: 'nous/poolside/laguna-xs-2.1:free', available: false },
      { id: 'qwen-oauth/qwen3', available: false },
    ];
    expect(staleModelPin(allLocked, 'nous/poolside/laguna-xs-2.1:free')).toEqual({
      pinned: 'nous/poolside/laguna-xs-2.1:free',
      fallback: undefined,
    });
  });
});

describe('flattenHermesModelOptions', () => {
  it('builds picker rows from /api/model/options and marks unsigned-in providers unavailable', () => {
    const rows = flattenHermesModelOptions({
      providers: [
        { slug: 'nous', name: 'Nous Portal', authenticated: true, models: ['poolside/laguna-xs-2.1:free'] },
        { slug: 'qwen-oauth', name: 'Qwen', authenticated: false, models: ['qwen3'] },
      ],
    });
    expect(rows).toEqual([
      {
        id: 'nous/poolside/laguna-xs-2.1:free',
        providerId: 'nous',
        modelId: 'poolside/laguna-xs-2.1:free',
        provider: 'Nous Portal',
        available: true,
        label: 'Nous Portal · poolside/laguna-xs-2.1:free',
      },
      {
        id: 'qwen-oauth/qwen3',
        providerId: 'qwen-oauth',
        modelId: 'qwen3',
        provider: 'Qwen',
        available: false,
        label: 'Qwen · qwen3',
      },
    ]);
  });

  it('is empty on a missing or empty catalog rather than throwing', () => {
    expect(flattenHermesModelOptions(undefined)).toEqual([]);
    expect(flattenHermesModelOptions({})).toEqual([]);
  });
});
