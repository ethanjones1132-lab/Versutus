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
