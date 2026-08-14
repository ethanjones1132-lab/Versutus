export type ProviderSnapshot = {
  id: string;
  label: string;
  providerType: string;
  mode: 'api_key' | 'oauth' | 'local_interface';
  auth: {
    state: 'missing' | 'authorizing' | 'ready' | 'refreshing' | 'needs_reauth' | 'denied' | 'disconnected';
    expiresAt?: string;
    scopes?: string[];
    credentialCustodian: 'gate' | 'external';
  };
  readiness: {
    state: 'ready' | 'degraded' | 'unavailable' | 'disabled';
    checkedAt: string;
    code?: string;
    message?: string;
  };
  catalog: {
    state: 'fresh' | 'stale' | 'unavailable';
    source: 'live' | 'last_known_good' | 'legacy_bootstrap';
    observedAt?: string;
    generation: number;
    models: {
      providerId: string;
      id: string;
      label?: string;
      available: boolean;
    }[];
  };
};

export type ProviderModelGroup = {
  providerId: string;
  label: string;
  catalogSource: ProviderSnapshot['catalog']['source'];
  models: {
    id: string;
    providerId: string;
    available: boolean;
    catalogState: ProviderSnapshot['catalog']['state'];
  }[];
};
