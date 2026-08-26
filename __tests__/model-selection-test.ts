import { effectiveModel, resolveSendModel, withSelectedModel,
  shouldReleaseSessionForModel, applyModelOverride,
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

  it('falls back to the profile model when the backend has no memory', () => {
    const profile = { ...BASE, backendModels: { 'codex-local': 'gpt-5.5' } };
    expect(effectiveModel(profile, 'opencode-local')).toBe('gateway-default');
  });

  it('falls back when no backend is selected', () => {
    expect(effectiveModel(BASE, undefined)).toBe('gateway-default');
  });

  it('is safe on a profile saved before backendModels existed', () => {
    expect(effectiveModel(BASE, 'codex-local')).toBe('gateway-default');
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
    expect(resolveSendModel(profile, 'hermes-local', undefined)).toEqual({ model: 'other' });
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

test('a first pick on a thread with no model yet keeps the thread', () => {
  // Nothing was overridden before, so the session is already running whatever
  // the gateway defaulted to — resetting here would cost context for nothing.
  expect(shouldReleaseSessionForModel({ next: 'kimi-k3', hasSession: true })).toBe(false);
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
