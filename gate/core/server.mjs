import { createServer } from 'node:http';
import { join } from 'node:path';

import { loadCapabilities, describeKinds, resolveManifestInstances } from './capabilities/registry.mjs';
import { buildInstanceHandlers } from './capabilities/dispatch.mjs';
import { createRegistryMethods } from './capabilities/registry-methods.mjs';
import { getSecret } from './capabilities/secrets.mjs';
import { buildManifest } from './manifest.mjs';
import { ProviderStore } from './providers/store.mjs';
import { migrateLegacyProviders } from './providers/migrate-v1.mjs';
import { ProviderService } from './providers/service.mjs';
import { CredentialVault } from './credentials/vault.mjs';
import { createProviderAdapter } from './providers/factory.mjs';
import { createProviderRpc, sanitizeSnapshot } from './providers/rpc.mjs';
import { OAuthManager } from './providers/oauth/refresh.mjs';
import { releaseOAuthProfiles } from './providers/oauth/profiles.mjs';
import { TokenStore } from './tokens.mjs';
import { PairingStore } from './pairing.mjs';
import { DeviceTokenStore } from './device-tokens.mjs';
import { verifySignedAccessRequest } from './signature.mjs';
import * as openaiFlavor from '../flavors/openai.mjs';
import * as anthropicFlavor from '../flavors/anthropic.mjs';

const FLAVOR_MODULES = { openai: openaiFlavor, anthropic: anthropicFlavor };

async function proxyChat(root, provider, requestBody, res) {
  const flavorModule = FLAVOR_MODULES[provider.config.flavor];
  if (!flavorModule) {
    res.writeHead(501, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: { message: `Chat is not implemented for flavor "${provider.config.flavor}"`, code: 'flavor_not_implemented' },
    }));
    return;
  }

  const wantsStream = requestBody.stream === true;
  if (wantsStream && provider.config.streaming === false) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: { message: `Provider "${provider.id}" does not support streaming`, code: 'streaming_unsupported' },
    }));
    return;
  }

  const apiKey = (await getSecret(root, provider.config.apiKeyEnv)) ?? process.env[provider.config.apiKeyEnv] ?? '';
  let upstreamRequest;
  try {
    upstreamRequest = flavorModule.buildChatRequest(provider.config, apiKey, {
      model: requestBody.model,
      messages: requestBody.messages ?? [],
      stream: wantsStream,
    });
  } catch (error) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: error.message, code: 'invalid_model' } }));
    return;
  }

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(upstreamRequest.url, upstreamRequest.init);
  } catch (error) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Upstream request failed: ${error.message}`, code: 'upstream_unreachable' } }));
    return;
  }

  if (!upstreamResponse.ok) {
    const text = await upstreamResponse.text().catch(() => '');
    res.writeHead(upstreamResponse.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: text || 'Upstream rejected the request', code: 'upstream_error' } }));
    return;
  }

  if (!wantsStream) {
    const json = await upstreamResponse.json();
    const text = flavorModule.parseResponseText(json);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: `gate-${Date.now()}`,
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    }));
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const reader = upstreamResponse.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const MAX_BUFFER_BYTES = 1024 * 1024; // 1MB — a single SSE line has no legitimate reason to exceed this
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > MAX_BUFFER_BYTES) {
        reader.cancel().catch(() => {});
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Upstream sent an oversized line without a delimiter', code: 'upstream_error' } }));
        return;
      }
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        const text = flavorModule.parseDelta(data);
        if (text) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

/**
 * Create and configure a Versutus Gate HTTP server
 * @param {Object} config
 * @param {string} config.root - Root directory for the Gate (capabilities and token store location)
 * @param {number} [config.port=0] - Port to listen on (0 = OS chooses)
 * @param {string} [config.name='Versutus Gate'] - Gateway name
 * @param {string} [config.version] - Gateway version
 * @returns {Promise<Object>} Gate object with token, providers, port, listen(), close()
 */
export async function createGate(config = {}) {
  const {
    root,
    port = 0,
    name = 'Versutus Gate',
    version,
    gateHome = process.env.VERSUTUS_GATE_HOME || join(root, '.gate-home'),
    vault: injectedVault,
  } = config;

  await migrateLegacyProviders({ sourceRoot: root, gateHome });
  const providerStore = new ProviderStore(gateHome);
  const vault = injectedVault ?? new CredentialVault({ gateHome });
  const oauth = new OAuthManager({ vault, profiles: releaseOAuthProfiles });
  const providerService = new ProviderService({
    store: providerStore,
    vault,
    createAdapter: (registration) => createProviderAdapter(registration, { vault, store: providerStore }),
  });
  const providerRpc = createProviderRpc({ service: providerService, vault, oauth });

  const tokenPath = join(root, '.tokens.json');

  // Live, mutable capability state. Recomputed by reload() after any
  // registry.instances.* mutation, so a new/edited/deleted instance is
  // reflected in routing, the manifest, and the RPC dispatch table without
  // restarting the Gate.
  async function computeState() {
    const { kinds, instances } = await loadCapabilities(root);
    const providers = instances
      .filter((instance) => instance.kind === 'provider')
      .map((instance) => ({ id: instance.id, label: instance.label, config: instance.config }));
    const manifest = buildManifest({
      name,
      version,
      capabilityKinds: describeKinds(kinds),
      capabilityInstances: resolveManifestInstances(kinds, instances),
    });
    const dispatch = buildInstanceHandlers(kinds, instances);
    return { kinds, instances, providers, manifest, dispatch };
  }

  let state = await computeState();
  async function reload() {
    state = await computeState();
    return state;
  }

  const registryMethods = {
    ...createRegistryMethods({ root, getState: () => state, reload, gateHome }),
    ...providerRpc,
  };

  // Initialize token store
  const tokenStore = new TokenStore(tokenPath);
  const token = await tokenStore.ensureToken();

  const pairing = new PairingStore(join(root, '.pairing.json'));
  const deviceTokens = new DeviceTokenStore(join(root, '.device-tokens.json'));
  const replayCache = new Set();

  // Create HTTP server
  const server = createServer(async (req, res) => {
    // Set common headers
    res.setHeader('Content-Type', 'application/json');

    // Parse URL and method
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;
    const method = req.method;

    async function readJsonBody(req) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return null;
      }
    }

    try {
      // Health endpoint (unauthenticated). Also served under each provider
      // base path so a child profile whose baseUrl is /p/{id} can probe
      // relative /health successfully.
      const healthMatch = pathname === '/health' || /^\/p\/[^/]+\/health$/.test(pathname);
      if (healthMatch && method === 'GET') {
        res.writeHead(200);
        res.end(JSON.stringify({
          status: 'ok',
          timestamp: new Date().toISOString(),
        }));
        return;
      }

      // Manifest endpoint (unauthenticated)
      if (pathname === '/.well-known/gateway.json' && method === 'GET') {
        res.writeHead(200);
        res.end(JSON.stringify(state.manifest));
        return;
      }

      // Pairing/access endpoint (unauthenticated)
      if (pathname === '/.well-known/gateway/access' && method === 'POST') {
        const body = await readJsonBody(req);
        const device = body?.device;
        if (!body || !device?.id || !device?.publicKey || !body.signature || typeof body.signedAtMs !== 'number') {
          res.writeHead(400);
          res.end(JSON.stringify({ status: 'denied', reason: 'Malformed access request.' }));
          return;
        }

        const verification = verifySignedAccessRequest(
          {
            deviceId: device.id,
            publicKeyB64Url: device.publicKey,
            clientId: device.clientId,
            role: body.role ?? 'operator',
            scopes: Array.isArray(body.scopes) ? body.scopes : [],
            signedAtMs: body.signedAtMs,
            signature: body.signature,
          },
          { replayCache },
        );

        if (!verification.ok) {
          res.writeHead(403);
          res.end(JSON.stringify({ status: 'denied', reason: verification.reason }));
          return;
        }

        const existing = await deviceTokens.list();
        const already = existing.find((entry) => entry.deviceId === device.id && !entry.revoked);
        if (already) {
          res.writeHead(200);
          res.end(JSON.stringify({ status: 'granted', token: already.token, role: already.role, scopes: already.scopes }));
          return;
        }

        const role = body.role ?? 'operator';
        const scopes = Array.isArray(body.scopes) ? body.scopes : [];

        if (await pairing.isWindowOpen()) {
          const grantedToken = await deviceTokens.issue(device.id, { role, scopes });
          res.writeHead(200);
          res.end(JSON.stringify({ status: 'granted', token: grantedToken, role, scopes }));
          return;
        }

        const requestId = await pairing.addPending({
          deviceId: device.id,
          publicKeyB64Url: device.publicKey,
          clientId: device.clientId,
          role,
          scopes,
        });
        res.writeHead(202);
        res.end(JSON.stringify({ status: 'pending', requestId }));
        return;
      }

      // Check if route exists before requiring authentication
      // This allows us to return 404 for unknown routes
      const isKnownAuthenticatedRoute =
        (pathname === '/v1/models' && method === 'GET') ||
        (pathname === '/v1/providers' && method === 'GET') ||
        /^\/v1\/providers\/[^/]+$/.test(pathname) ||
        /^\/p\/[^/]+\/v1\/models$/.test(pathname) ||
        (pathname === '/v1/chat/completions' && method === 'POST') ||
        /^\/p\/[^/]+\/v1\/chat\/completions$/.test(pathname) ||
        (pathname === '/v1/capabilities/rpc' && method === 'POST') ||
        /^\/p\/[^/]+\/v1\/capabilities\/rpc$/.test(pathname);

      if (!isKnownAuthenticatedRoute) {
        // Unknown route - return 404
        res.writeHead(404);
        res.end(JSON.stringify({
          error: 'Not Found',
          message: `${method} ${pathname} not found`,
        }));
        return;
      }

      // All authenticated endpoints require authentication
      const authHeader = req.headers.authorization;
      const isAuthenticated = (await tokenStore.verify(authHeader)) || Boolean(await deviceTokens.verify(authHeader));

      if (!isAuthenticated) {
        res.writeHead(401);
        res.end(JSON.stringify({
          error: 'Unauthorized',
          message: 'Bearer token required',
        }));
        return;
      }

      // Authenticated endpoints

      if (pathname === '/v1/providers' && method === 'GET') {
        const snapshots = await providerService.list();
        res.writeHead(200);
        res.end(JSON.stringify({ providers: snapshots.map(sanitizeSnapshot) }));
        return;
      }

      const providerMatch = pathname.match(/^\/v1\/providers\/([^/]+)$/);
      if (providerMatch && method === 'GET') {
        try {
          const snapshot = await providerService.get(decodeURIComponent(providerMatch[1]));
          res.writeHead(200);
          res.end(JSON.stringify(sanitizeSnapshot(snapshot)));
        } catch {
          res.writeHead(404);
          res.end(JSON.stringify({ error: { message: 'provider not found', code: 'provider_not_found' } }));
        }
        return;
      }

      // /v1/models - provider-owned live or labeled LKG/bootstrap catalogs
      if (pathname === '/v1/models' && method === 'GET') {
        const snapshots = await providerService.list();
        const allModels = [];
        for (const snapshot of snapshots) {
          const models = snapshot.catalog?.models?.length
            ? snapshot.catalog.models.map((model) => model.id)
            : state.providers.find((provider) => provider.id === snapshot.id)?.config.models ?? [];
          for (const modelId of models) {
            allModels.push({
              id: modelId,
              provider: snapshot.id,
              providerId: snapshot.id,
              label: modelId,
              object: 'model',
              catalogSource: snapshot.catalog?.source,
            });
          }
        }
        if (allModels.length === 0) {
          for (const provider of state.providers) {
            for (const modelId of provider.config.models || []) {
              allModels.push({
                id: modelId,
                provider: provider.id,
                providerId: provider.id,
                label: modelId,
                object: 'model',
              });
            }
          }
        }
        res.writeHead(200);
        res.end(JSON.stringify({
          object: 'list',
          data: allModels,
        }));
        return;
      }

      // /p/{provider}/v1/models - scoped provider models
      const scopedModelMatch = pathname.match(/^\/p\/([^\/]+)\/v1\/models$/);
      if (scopedModelMatch && method === 'GET') {
        const providerId = decodeURIComponent(scopedModelMatch[1]);
        const provider = state.providers.find((p) => p.id === providerId);

        if (!provider) {
          res.writeHead(404);
          res.end(JSON.stringify({
            error: 'Not Found',
            message: `Provider ${providerId} not found`,
          }));
          return;
        }

        const models = provider.config.models || [];
        const modelList = models.map((modelId) => ({
          id: modelId,
          provider: provider.id,
          label: modelId,
          object: 'model',
        }));

        res.writeHead(200);
        res.end(JSON.stringify({
          object: 'list',
          data: modelList,
        }));
        return;
      }

      // /v1/chat/completions - unscoped chat (resolves provider from model)
      if (pathname === '/v1/chat/completions' && method === 'POST') {
        const body = (await readJsonBody(req)) ?? {};
        const snapshots = await providerService.list();
        const advertised = snapshots.flatMap((snapshot) => (
          snapshot.catalog?.models ?? []
        ).map((model) => ({ providerId: snapshot.id, modelId: model.id })));
        for (const provider of state.providers) {
          for (const modelId of provider.config.models || []) {
            if (!advertised.some((entry) => entry.providerId === provider.id && entry.modelId === modelId)) {
              advertised.push({ providerId: provider.id, modelId });
            }
          }
        }
        if (!body.model && advertised[0]) {
          body.model = advertised[0].modelId;
        }
        const matches = advertised.filter((entry) => entry.modelId === body.model);
        if (body.providerId) {
          const provider = state.providers.find((item) => item.id === body.providerId)
            ?? (await providerService.get(body.providerId).then(() => ({ id: body.providerId, config: { models: [body.model], flavor: 'openai', streaming: true } })).catch(() => null));
          if (!provider) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: `Unknown provider "${body.providerId}"`, code: 'unknown_provider' } }));
            return;
          }
          if (state.providers.some((item) => item.id === body.providerId)) {
            await proxyChat(root, state.providers.find((item) => item.id === body.providerId), body, res);
          } else {
            try {
              const result = await providerService.chat({ providerId: body.providerId, ...body });
              res.writeHead(200);
              res.end(JSON.stringify(result));
            } catch (error) {
              res.writeHead(502);
              res.end(JSON.stringify({ error: { message: error.message, code: error.code || 'upstream_error' } }));
            }
          }
          return;
        }
        if (matches.length > 1) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `Model "${body.model}" is declared by multiple providers`, code: 'ambiguous_model' } }));
          return;
        }
        const provider = state.providers.find((item) => item.id === matches[0]?.providerId)
          ?? state.providers.find((item) => item.config.models.includes(body?.model));
        if (!provider) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `No provider declares model "${body?.model}"`, code: 'unknown_model' } }));
          return;
        }
        await proxyChat(root, provider, body, res);
        return;
      }

      // /p/{provider}/v1/chat/completions - scoped chat
      const scopedChatMatch = pathname.match(/^\/p\/([^/]+)\/v1\/chat\/completions$/);
      if (scopedChatMatch && method === 'POST') {
        const providerId = decodeURIComponent(scopedChatMatch[1]);
        const provider = state.providers.find((p) => p.id === providerId);
        if (!provider) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `Unknown provider "${providerId}"`, code: 'unknown_provider' } }));
          return;
        }
        const body = await readJsonBody(req);
        await proxyChat(root, provider, body ?? {}, res);
        return;
      }

      // /v1/capabilities/rpc — also remounted under /p/{id} so a child
      // profile whose baseUrl is /p/{id} can POST the advertised path.
      const rpcMatch = pathname === '/v1/capabilities/rpc' || /^\/p\/[^/]+\/v1\/capabilities\/rpc$/.test(pathname);
      if (rpcMatch && method === 'POST') {
        const body = await readJsonBody(req);
        const rpcMethod = body?.method;
        const params = body?.params ?? {};
        if (typeof rpcMethod !== 'string' || !rpcMethod) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'method must be a non-empty string', code: 'invalid_request' } }));
          return;
        }
        const handler = registryMethods[rpcMethod] ?? state.dispatch.get(rpcMethod);
        if (!handler) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `Unknown method "${rpcMethod}"`, code: 'unknown_method' } }));
          return;
        }
        try {
          const result = await handler(params);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ result }));
        } catch (error) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: error.message, code: 'rpc_error' } }));
        }
        return;
      }
    } catch (err) {
      console.error('Request handler error:', err);
      res.writeHead(500);
      res.end(JSON.stringify({
        error: 'Internal Server Error',
        message: err.message,
      }));
    }
  });

  // Start listening immediately
  const gateObj = {
    token,
    get providers() {
      return state.providers;
    },
    port,
    async listen() {
      return new Promise((resolve, reject) => {
        server.listen(port, () => {
          const actualPort = server.address().port;
          gateObj.port = actualPort;
          resolve(actualPort);
        });
        server.on('error', reject);
      });
    },
    async close() {
      return new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };

  // Start listening
  await gateObj.listen();

  return gateObj;
}
