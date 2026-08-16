import { createProfileAdapter, getProfile } from './profiles/registry.mjs';
import { createLocalProviderAdapter } from './local/adapter.mjs';
import { isLoopbackHostname } from './local/ssrf-policy.mjs';

export function profileIdFor(providerType) {
  if (providerType === 'nvidia-nim') return 'nvidia-nim';
  if (providerType === 'anthropic') return 'anthropic';
  if (providerType === 'xai') return 'xai';
  if (providerType === 'openai-compatible') return 'openai-compatible';
  return 'openai';
}

export function createProviderAdapter(config, { vault, store } = {}) {
  return {
    authenticate: async () => (await materialize()).authenticate(),
    health: async () => (await materialize()).health(),
    listModels: async () => (await materialize()).listModels(),
    chat: async (request, signal) => (await materialize()).chat(request, signal),
    disconnect: async () => {
      const inner = await materialize().catch(() => null);
      return inner?.disconnect?.();
    },
  };

  async function materialize() {
    const registration = config.registration;
    if (registration.mode === 'local_interface') {
      let credential;
      if (registration.adapterCredentialRef && vault) {
        credential = await vault.get(registration.adapterCredentialRef);
      }
      return createLocalProviderAdapter({
        manifestUrl: registration.manifestUrl,
        providerId: config.id,
        credential,
      });
    }

    const credential = await resolveCredential(config, vault, store);
    const profileId = profileIdFor(config.providerType);
    const profile = getProfile(profileId);
    const origin = new URL(registration.baseUrl || registration.resourceBaseUrl).origin;
    return createProfileAdapter({
      profileId,
      providerId: config.id,
      baseUrl: registration.baseUrl || registration.resourceBaseUrl,
      credential,
      allowedOrigins: [origin, ...profile.origins],
    });
  }
}

async function resolveCredential(config, vault, store) {
  const ref = config.registration.credentialRef;
  if (ref && vault) {
    const value = await vault.get(ref);
    if (value) return value;
  }
  const record = store ? await store.get(config.id) : null;
  const envName = record?.state?.legacyApiKeyEnv;
  if (envName && process.env[envName]) return process.env[envName];
  return undefined;
}

export { isLoopbackHostname };
