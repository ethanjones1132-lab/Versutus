import { ManifestClient } from './manifest-client.mjs';
import { MAX_STREAM_BYTES, readJsonLimited } from './ssrf-policy.mjs';

export async function createLocalProviderAdapter({
  manifestUrl,
  providerId,
  credential,
  onWarning,
  fetchImpl = fetch,
} = {}) {
  const client = new ManifestClient({ manifestUrl, fetchImpl });
  const manifest = await client.discover();
  const origin = new URL(manifestUrl);
  const schemes = manifest.auth?.schemes ?? ['bearer'];

  if (schemes.includes('none') && !credential) {
    onWarning?.('unauthenticated local provider (auth.schemes: none) is allowed only on loopback');
  }

  function resolve(path) {
    return new URL(path, origin);
  }

  function headers() {
    const next = { accept: 'application/json' };
    if (credential) next.authorization = `Bearer ${credential}`;
    return next;
  }

  return {
    manifest,
    credentialCustodian: manifest.auth?.credentialCustodian ?? 'external',
    async authenticate() {
      return { state: 'ready' };
    },
    async health() {
      const response = await client.fetchLimited(resolve(manifest.endpoints.health), { headers: headers() });
      if (!response.ok) {
        const error = new Error(`local provider health failed: ${response.status}`);
        error.status = response.status;
        throw error;
      }
      await readJsonLimited(response);
      return { state: 'ready' };
    },
    async listModels() {
      const response = await client.fetchLimited(resolve(manifest.endpoints.models), { headers: headers() });
      if (!response.ok) {
        const error = new Error(`local provider models failed: ${response.status}`);
        error.status = response.status;
        throw error;
      }
      const payload = await readJsonLimited(response);
      return (payload.data ?? payload.models ?? []).map((model) => ({
        providerId,
        id: model.id,
        label: model.label ?? model.id,
        available: model.available !== false,
        inputModalities: model.inputModalities,
        outputModalities: model.outputModalities,
        contextLength: model.contextLength,
      }));
    },
    async chat(request, signal) {
      const chatHeaders = headers();
      if (request.stream) chatHeaders.accept = 'text/event-stream';
      const response = await client.fetchLimited(resolve(manifest.endpoints.chat), {
        method: 'POST',
        headers: { ...chatHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages ?? [],
          stream: Boolean(request.stream),
        }),
        signal,
      });
      if (!response.ok) {
        const error = new Error(`local provider chat failed: ${response.status}`);
        error.status = response.status;
        throw error;
      }
      if (request.stream) {
        return streamSse(response);
      }
      return readJsonLimited(response);
    },
    async disconnect() {},
  };
}

async function* streamSse(response) {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_STREAM_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error('unbounded stream exceeded MAX_STREAM_BYTES');
    }
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      const line = part.split('\n').find((entry) => entry.startsWith('data:'));
      if (!line) continue;
      const data = line.slice('data:'.length).trim();
      if (data === '[DONE]') return;
      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        yield data;
      }
    }
  }
}
