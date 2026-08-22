import type { EnvironmentSnapshot } from '@/lib/gateway/environment-types';
import type { ProviderSnapshot } from '@/lib/gateway/provider-types';

export type CardAction = { id: string; label: string };

/**
 * The one action a card should lead with. Seven equal buttons made every
 * provider look the same regardless of what it actually needed next.
 */
export function providerPrimaryAction(snapshot: ProviderSnapshot): CardAction {
  if (snapshot.auth.state === 'missing') {
    return snapshot.mode === 'oauth'
      ? { id: 'authorize', label: 'Authorize' }
      : { id: 'set-key', label: 'Set key' };
  }
  if (snapshot.auth.state === 'needs_reauth' || snapshot.auth.state === 'denied') {
    return { id: 'authorize', label: 'Sign in again' };
  }
  if (snapshot.readiness.state === 'disabled') return { id: 'enable', label: 'Enable' };
  if (snapshot.readiness.state === 'ready') return { id: 'refresh', label: 'Refresh catalog' };
  return { id: 'check', label: 'Check' };
}

/**
 * The Gate's environment states are ready | busy | stopped | disabled |
 * not_installed | incompatible | degraded. A live one offers Stop; a disabled
 * one can only be re-checked; anything else offers Start.
 */
export function environmentPrimaryAction(environment: EnvironmentSnapshot): CardAction {
  if (environment.state === 'ready' || environment.state === 'busy') {
    return { id: 'stop', label: 'Stop' };
  }
  if (environment.state === 'disabled') return { id: 'check', label: 'Check' };
  return { id: 'start', label: 'Start' };
}

/**
 * The one-line statement of the environment's per-run time budget for its
 * card. The edit form is where the budget CHANGES; this line is where it can
 * be SEEN without opening Edit — including "none", because an operator whose
 * task hangs needs to see that no budget will stop it. Older Gates and
 * records without a limit both read as no limit (the Gate's default).
 */
export function environmentRunBudgetLine(environment: EnvironmentSnapshot): string {
  const seconds = environment.lifecycle.maxRunSeconds;
  return seconds !== undefined
    ? `Time limit per run: ${seconds}s — the Gate stops a task past this.`
    : 'No time limit per run — tasks run until finished.';
}
