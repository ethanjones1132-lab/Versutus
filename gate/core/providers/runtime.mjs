import { authStateForCode } from './errors.mjs';

export function toSnapshot(config, state = {}, extras = {}) {
  const mode = config.registration?.mode;
  const catalog = extras.catalog ?? state.catalog ?? {
    source: 'legacy_bootstrap',
    state: 'unavailable',
    generation: 0,
    models: [],
  };
  const auth = extras.auth ?? state.auth ?? {
    state: 'missing',
    credentialCustodian: mode === 'local_interface' ? 'external' : 'gate',
  };
  const readiness = extras.readiness ?? state.readiness ?? {
    state: 'unavailable',
    checkedAt: new Date().toISOString(),
  };

  return {
    id: config.id,
    label: config.label,
    providerType: config.providerType,
    mode,
    auth,
    readiness,
    catalog,
  };
}

export function nextAuthState({ mode, present, errorCode, previous = 'missing' }) {
  if (mode === 'local_interface') {
    return {
      state: present ? 'ready' : 'disconnected',
      credentialCustodian: 'external',
    };
  }
  if (!present) {
    return { state: 'missing', credentialCustodian: 'gate' };
  }
  return {
    state: authStateForCode(errorCode, previous === 'missing' ? 'ready' : previous),
    credentialCustodian: 'gate',
  };
}
