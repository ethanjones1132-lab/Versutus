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

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const MAX_REQUEST_TIMEOUT_MS = 30_000;

export function createProfileAdapter({
  profileId,
  providerId,
  baseUrl,
  credential,
  allowedOrigins,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
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
      // A catalog probe has to end: fetch has no timeout of its own, so a
      // vendor that accepts the socket and says nothing held this request --
      // and the provider's commit queue behind it -- until the process did.
      const bounded = boundedRequest(timeoutMs);
      let response;
      try {
        response = await fetchImpl(url, {
          headers: {
            accept: 'application/json',
            ...profile.authHeaders(credential),
          },
          signal: bounded.signal,
        });
        if (!response.ok) {
          const detail = await vendorDetail(response);
          const error = new Error(`models request failed: ${response.status}${detail}`);
          error.status = response.status;
          if (profile.keepBootstrapIfEmpty) error.code = 'catalog_timeout';
          throw error;
        }
        return profile.parseModels(await response.json(), providerId);
      } catch (error) {
        // Reported as ETIMEDOUT so it classifies as a transient network fault
        // instead of as an unknown error the same code path would also file
        // under "transient_network" for the wrong reason.
        if (!bounded.expired) throw error;
        const timeout = new Error(`models request timed out after ${bounded.budgetMs}ms`);
        timeout.code = 'ETIMEDOUT';
        throw timeout;
      } finally {
        bounded.clear();
      }
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
        const detail = await vendorDetail(response);
        const error = new Error(`chat failed: ${response.status}${detail}`);
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

// How much of a vendor's own explanation reaches the card. Enough for the reason
// a vendor gives, bounded because the body is not the Gate's to trust the size of.
const MAX_VENDOR_DETAIL_BYTES = 512;

/**
 * What the vendor said about the refusal, and the body consumed either way.
 *
 * Both halves mattered. Undici cannot hand an unread body back to its pool, so
 * every 401, 429 and 5xx used to hold its connection until the process did; and
 * `classifyProviderError` reads `error.status` alone, so a 401 saying "your key
 * is suspended" was indistinguishable from one saying "invalid key", and the
 * retry-after a rate limit names was thrown away. The legacy path at
 * `server.mjs`'s `proxyChat` already read the body for its message.
 */
async function vendorDetail(response) {
  let text = '';
  try {
    text = await readVendorBody(response, MAX_VENDOR_DETAIL_BYTES);
  } catch {
    await response.body?.cancel?.().catch(() => {});
  }
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return '';
  return trimmed.length > MAX_VENDOR_DETAIL_BYTES
    ? ` — ${trimmed.slice(0, MAX_VENDOR_DETAIL_BYTES)}…`
    : ` — ${trimmed}`;
}

/**
 * Bound the read itself, the way `readLimited` does on the local path.
 * `response.text()` then a slice still fully buffers a large vendor body.
 */
async function readVendorBody(response, maxBytes) {
  if (typeof response.body?.getReader !== 'function') {
    const text = await response.text();
    return String(text ?? '').slice(0, maxBytes);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      const take = Math.min(value.byteLength, maxBytes - total);
      chunks.push(Buffer.from(value.subarray(0, take)));
      total += take;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * A signal that ends the request it was given to, on a budget that is never
 * longer than the ceiling below -- a registration's own `timeoutMs` is what the
 * operator chose, and the phone gives up at 30s, so nothing here may hold a
 * socket for minutes. The timer is unref'd (a pending budget must not keep the
 * Gate alive) and cleared by the caller as soon as the request settles, so a
 * fast answer leaves nothing behind.
 */
function boundedRequest(timeoutMs) {
  const budgetMs = Math.min(Number(timeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS, MAX_REQUEST_TIMEOUT_MS);
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, budgetMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    budgetMs,
    get expired() {
      return expired;
    },
    clear() {
      clearTimeout(timer);
    },
  };
}
