import { buildChatRequest as buildOpenAIChat } from '../../../flavors/openai.mjs';
import { buildChatRequest as buildAnthropicChat } from '../../../flavors/anthropic.mjs';
import { openaiProfile } from './openai.mjs';
import { anthropicProfile } from './anthropic.mjs';
import { nvidiaNimProfile } from './nvidia-nim.mjs';
import { xaiProfile } from './xai.mjs';
import { openaiCompatibleProfile } from './openai-compatible.mjs';

export const releaseProfiles = new Map([
  [openaiProfile.id, openaiProfile],
  [anthropicProfile.id, anthropicProfile],
  [nvidiaNimProfile.id, nvidiaNimProfile],
  [xaiProfile.id, xaiProfile],
  [openaiCompatibleProfile.id, openaiCompatibleProfile],
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
        if (profile.keepBootstrapIfEmpty) error.code = 'catalog_timeout';
        throw error;
      }
      return profile.parseModels(await response.json(), providerId);
    },
    async chat(request, signal) {
      assertAllowedOrigin(baseUrl, origins);
      const build = profile.protocol === 'anthropic_messages' ? buildAnthropicChat : buildOpenAIChat;
      const model = request.model;
      const built = build({ baseUrl, models: model ? [model] : ['default'] }, credential, {
        model,
        messages: request.messages ?? [],
        stream: request.stream,
      });
      const response = await fetchImpl(built.url, {
        ...built.init,
        headers: {
          ...built.init.headers,
          ...profile.authHeaders(credential),
        },
        signal,
      });
      if (!response.ok) {
        const error = new Error(`chat failed: ${response.status}`);
        error.status = response.status;
        throw error;
      }
      if (request.stream) return response;
      return response.json();
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
  if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1') {
    return;
  }
  const allowed = origins.some((origin) => parsed.origin === new URL(origin).origin);
  if (!allowed) {
    throw new Error(`origin ${parsed.origin} is not allowed`);
  }
}
