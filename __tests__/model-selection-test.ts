import { effectiveModel, resolveSendModel, withSelectedModel } from '@/lib/gateway/model-selection';
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
