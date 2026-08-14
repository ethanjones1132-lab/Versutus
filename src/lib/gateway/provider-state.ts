import type { ProviderModelGroup, ProviderSnapshot } from '@/lib/gateway/provider-types';

export function groupProviderModels(snapshots: ProviderSnapshot[]): ProviderModelGroup[] {
  return snapshots.map((snapshot) => ({
    providerId: snapshot.id,
    label: snapshot.label,
    catalogSource: snapshot.catalog.source,
    models: snapshot.catalog.models.map((model) => ({
      id: model.id,
      providerId: snapshot.id,
      available: model.available,
      catalogState: snapshot.catalog.state,
    })),
  }));
}

export function providerUiState(snapshot: ProviderSnapshot): string {
  if (!snapshot.readiness || snapshot.auth.state === 'missing') return 'Not configured';
  if (snapshot.auth.state === 'authorizing') return 'Authorizing';
  if (snapshot.readiness.state === 'disabled') return 'Disabled';
  if (snapshot.auth.state === 'denied') return 'Access denied';
  if (snapshot.auth.state === 'needs_reauth') return 'Needs sign-in';
  if (snapshot.mode === 'local_interface' && snapshot.readiness.state === 'unavailable') return 'Local service offline';
  if (snapshot.readiness.state === 'degraded' || snapshot.catalog.state === 'stale') return 'Degraded/stale';
  if (snapshot.readiness.state === 'ready' && snapshot.auth.state === 'ready') return 'Ready';
  return snapshot.readiness.state;
}
