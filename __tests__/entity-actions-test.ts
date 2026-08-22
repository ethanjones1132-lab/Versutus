import { environmentPrimaryAction, environmentRunBudgetLine, providerPrimaryAction } from '@/lib/gateway/entity-actions';
import type { ProviderSnapshot } from '@/lib/gateway/provider-types';
import type { EnvironmentSnapshot } from '@/lib/gateway/environment-types';

function provider(overrides: Partial<ProviderSnapshot> = {}): ProviderSnapshot {
  return {
    id: 'p',
    label: 'P',
    providerType: 'openai-compatible',
    mode: 'api_key',
    auth: { state: 'ready', credentialCustodian: 'gate' },
    readiness: { state: 'ready', checkedAt: '' },
    catalog: { state: 'fresh', source: 'live', generation: 1, models: [] },
    ...overrides,
  } as ProviderSnapshot;
}

describe('providerPrimaryAction', () => {
  it('asks for a key when an api-key provider has none', () => {
    const action = providerPrimaryAction(provider({ auth: { state: 'missing', credentialCustodian: 'gate' } }));
    expect(action).toEqual({ id: 'set-key', label: 'Set key' });
  });

  it('asks for authorization when an oauth provider has no credential', () => {
    const action = providerPrimaryAction(
      provider({ mode: 'oauth', auth: { state: 'missing', credentialCustodian: 'gate' } }),
    );
    expect(action).toEqual({ id: 'authorize', label: 'Authorize' });
  });

  it('asks to sign in again after a revoked credential', () => {
    const action = providerPrimaryAction(
      provider({ auth: { state: 'needs_reauth', credentialCustodian: 'gate' } }),
    );
    expect(action).toEqual({ id: 'authorize', label: 'Sign in again' });
  });

  it('offers a catalog refresh when ready', () => {
    expect(providerPrimaryAction(provider())).toEqual({ id: 'refresh', label: 'Refresh catalog' });
  });

  it('offers a check when degraded', () => {
    const action = providerPrimaryAction(provider({ readiness: { state: 'degraded', checkedAt: '' } }));
    expect(action).toEqual({ id: 'check', label: 'Check' });
  });

  it('offers enable when disabled', () => {
    const action = providerPrimaryAction(provider({ readiness: { state: 'disabled', checkedAt: '' } }));
    expect(action).toEqual({ id: 'enable', label: 'Enable' });
  });
});

describe('environmentPrimaryAction', () => {
  const environment = (state: string) => ({ state }) as EnvironmentSnapshot;

  it('offers stop while ready', () => {
    expect(environmentPrimaryAction(environment('ready'))).toEqual({ id: 'stop', label: 'Stop' });
  });

  it('offers stop while busy', () => {
    expect(environmentPrimaryAction(environment('busy'))).toEqual({ id: 'stop', label: 'Stop' });
  });

  it('offers start when stopped', () => {
    expect(environmentPrimaryAction(environment('stopped'))).toEqual({ id: 'start', label: 'Start' });
  });

  it('offers a check when disabled', () => {
    expect(environmentPrimaryAction(environment('disabled'))).toEqual({ id: 'check', label: 'Check' });
  });
});

describe('environmentRunBudgetLine', () => {
  const environment = (lifecycle?: Partial<EnvironmentSnapshot['lifecycle']>) =>
    ({ lifecycle: { startup: 'skip', maxConcurrentRuns: 1, ...lifecycle } }) as EnvironmentSnapshot;

  it('names the budget when the record sets one', () => {
    expect(environmentRunBudgetLine(environment({ maxRunSeconds: 600 }))).toBe(
      'Time limit per run: 600s — the Gate stops a task past this.',
    );
  });

  it('says tasks run unbounded when no budget is set', () => {
    expect(environmentRunBudgetLine(environment())).toBe(
      'No time limit per run — tasks run until finished.',
    );
  });
});
