import { openaiProfile } from './openai.mjs';
import { anthropicProfile } from './anthropic.mjs';
import { nvidiaNimProfile } from './nvidia-nim.mjs';
import { xaiProfile } from './xai.mjs';

export const releaseProfiles = new Map([
  [openaiProfile.id, openaiProfile],
  [anthropicProfile.id, anthropicProfile],
  [nvidiaNimProfile.id, nvidiaNimProfile],
  [xaiProfile.id, xaiProfile],
]);

export function getProfile(id) {
  const profile = releaseProfiles.get(id);
  if (!profile) throw new Error(`unknown provider profile "${id}"`);
  return profile;
}

export function createProfileAdapter({
  profileId,
  providerId,
  baseUrl,
  credential,
  allowedOrigins,
  fetchImpl = fetch,
}) {
  const profile = getProfile(profileId);
  const origins = allowedOrigins ?? profile.origins;

  return {
    async authenticate() {
      if (!credential) {
        const error = new Error('missing credentials');
        error.code = 'missing_credentials';
        throw error;
      }
      return { state: 'ready' };
    },
    async health() {
      await this.listModels();
      return { state: 'ready' };
    },
    async listModels() {
      assertAllowedOrigin(baseUrl, origins);
      const url = new URL(profile.modelsPath.replace(/^\//, ''), `${baseUrl.replace(/\/+$/, '')}/`);
      const response = await fetchImpl(url, {
        headers: {
          accept: 'application/json',
          ...profile.authHeaders(credential),
        },
      });
      if (!response.ok) {
        const error = new Error(`models request failed: ${response.status}`);
        error.status = response.status;
        throw error;
      }
      return profile.parseModels(await response.json(), providerId);
    },
    async chat() {
      throw new Error('chat is owned by the flavor codec, not the profile registry');
    },
    async disconnect() {},
  };
}

function assertAllowedOrigin(baseUrl, origins) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error('origin is not allowed');
  }
  const allowed = origins.some((origin) => parsed.origin === new URL(origin).origin);
  if (!allowed) {
    throw new Error(`origin ${parsed.origin} is not allowed`);
  }
}
