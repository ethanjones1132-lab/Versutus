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
import { CliEnvironmentStore } from './cli-environments/store.mjs';
import { CliAdapterRegistry } from './cli-environments/adapter-registry.mjs';
import { CliEnvironmentService } from './cli-environments/supervisor.mjs';
import { createEnvironmentRpc, sanitizeEnvironment } from './cli-environments/rpc.mjs';
import { createBackendManager } from './cli-environments/backend-manager.mjs';
import { buildCliEnvironment } from './cli-environments/process-environment.mjs';
import { TokenStore } from './tokens.mjs';
import { PairingStore } from './pairing.mjs';
import { DeviceTokenStore } from './device-tokens.mjs';
import { verifySignedAccessRequest } from './signature.mjs';
import * as openaiFlavor from '../flavors/openai.mjs';
import * as anthropicFlavor from '../flavors/anthropic.mjs';

const FLAVOR_MODULES = { openai: openaiFlavor, anthropic: anthropicFlavor };

/** The turn to send onward. A native session already holds the history. */
function lastUserText(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user') continue;
    const content = message.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((part) => part?.text ?? '').join('');
  }
  return '';
}

/**
 * Relay a native-environment turn as OpenAI-shaped SSE.
 *
 * Subscribing before sending matters: the CLI starts emitting as soon as the
 * turn is accepted, and a late subscriber loses the opening deltas. Tool events
 * are relayed as `tool_calls` deltas so the client can show what the agent is
 * doing — the thing a bare provider proxy can never report.
 */
async function streamBackendTurn(backend, sessionId, { text, model }, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  // A response that closes before we finish is the client walking away (the
  // app's "stop" affordance aborting its fetch, or the network dropping) —
  // not the turn failing. `res.end()` is only ever called from the bottom of
  // this function, so any 'close' observed before that point is premature.
  let clientDisconnected = false;
  res.on('close', () => { clientDisconnected = true; });

  const controller = new AbortController();
  let toolIndex = 0;
  const seenTools = new Map();
  // A tool call is real turn activity with no closing text of its own — only
  // a turn where *neither* text nor a tool ever happened counts as empty.
  let sawContent = false;

  const streaming = backend
    .streamEvents(
      sessionId,
      (event) => {
        if (event.type === 'message.delta' && event.payload.text) {
          sawContent = true;
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: event.payload.text } }] })}\n\n`);
          return;
        }
        if (event.type === 'tool.started' && event.payload.name) {
          if (seenTools.has(event.payload.callId)) return;
          sawContent = true;
          const index = toolIndex++;
          seenTools.set(event.payload.callId, index);
          res.write(`data: ${JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index, function: { name: event.payload.name } }] } }],
          })}\n\n`);
        }
      },
      controller.signal,
    )
    .catch(() => undefined);

  try {
    const result = await backend.sendMessage(sessionId, { text, model });
    const hasContent = sawContent
      || Boolean(result?.text && result.text.trim())
      || Boolean(result?.message?.tool_calls?.length);
    if (!clientDisconnected && !hasContent) {
      // The backend reported the turn as done, but nothing came back that
      // the user could see — a clean [DONE] here would render as a silent
      // empty bubble with no indication anything went wrong.
      res.write(`data: ${JSON.stringify({
        error: { message: 'The backend completed the turn with no assistant content.', code: 'empty_turn' },
      })}\n\n`);
    }
  } catch (error) {
    if (!clientDisconnected) {
      res.write(`data: ${JSON.stringify({ error: { message: error.message, code: 'backend_error' } })}\n\n`);
    }
  } finally {
    controller.abort();
    await streaming;
    if (!clientDisconnected) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }
}

/** Backend models are `providerId/modelId`, since a CLI reaches many vendors. */
function parseQualifiedModel(model) {
  const separator = String(model).indexOf('/');
  if (separator === -1) return { modelId: String(model) };
  return { providerId: String(model).slice(0, separator), modelId: String(model).slice(separator + 1) };
}

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

  await relayNormalizedSse(upstreamResponse, flavorModule, res);
}

/**
 * Read an upstream SSE body and re-emit it in the OpenAI delta shape the app's
 * clients parse, whatever dialect the vendor speaks.
 */
async function relayNormalizedSse(upstreamResponse, flavorModule, res) {
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
        res.end(`data: ${JSON.stringify({ error: { message: 'Upstream sent an oversized line without a delimiter', code: 'upstream_error' } })}\n\n`);
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
    environmentRegistry: injectedRegistry,
    backendServerFactory,
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
  const providerRpc = createProviderRpc({
    service: providerService,
    vault,
    oauth,
    // The manifest advertises providers, so a newly registered one must be
    // visible without restarting the Gate.
    onChanged: () => reload(),
  });
  const environmentStore = new CliEnvironmentStore(gateHome);
  const environmentRegistry = injectedRegistry ?? new CliAdapterRegistry();
  const environmentService = new CliEnvironmentService({
    store: environmentStore,
    registry: environmentRegistry,
  });
  const environmentRpc = createEnvironmentRpc({
    store: environmentStore,
    service: environmentService,
    registry: environmentRegistry,
    // The manifest advertises backends and the capabilities they provide, so a
    // newly attached CLI must be visible without restarting the Gate.
    onChanged: () => reload(),
  });

  // Environments that expose a native server become chat backends: they own
  // their own sessions, models and tools, and the Gate proxies to them rather
  // than reimplementing any of it.
  const backendManager = createBackendManager({
    store: environmentStore,
    registry: environmentRegistry,
    vault,
    environmentState: environmentService.environmentState,
    buildEnvironment: async ({ record, credentials }) =>
      buildCliEnvironment(process.env, {
        environmentId: record.id,
        runId: `serve-${record.id}`,
        endpoints: { chat: `http://127.0.0.1:${gateObj?.port ?? port}/v1/chat/completions` },
        credentials,
      }),
    createServer: backendServerFactory,
  });

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
    // Sessions and tools are only advertised because a backend actually
    // provides them; a Gate with no environment attached must not claim either.
    const backends = await backendManager.describe().catch(() => []);
    // v2 providers live under Gate home and are owned by ProviderService, so
    // loadCapabilities(root) — which only reads the legacy registry — cannot
    // see them. A failure here must not take the manifest down.
    const providerSnapshots = await providerService.list().catch(() => []);
    const manifest = buildManifest({
      name,
      version,
      backends,
      providerSnapshots,
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

  /**
   * Send a chat request to whichever component actually owns the provider's
   * credentials.
   *
   * `migrateLegacyProviders` copies `registry/<id>.json` into the v2 store but
   * leaves the original file in place, so `loadCapabilities` keeps surfacing a
   * legacy twin under the same id forever. That twin must never win: the flavor
   * codecs deliberately emit no auth header (auth moved into provider profiles
   * — see gate/flavors/openai.mjs), and its `apiKeyEnv`/static `models[]` are
   * the stale bootstrap values. Routing a migrated provider through proxyChat
   * reaches the vendor unauthenticated and rejects every model discovered since.
   */
  async function dispatchChat(providerId, body, res) {
    const record = await providerStore.get(providerId);
    const legacy = state.providers.find((item) => item.id === providerId);

    if (!record && !legacy) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Unknown provider "${providerId}"`, code: 'unknown_provider' } }));
      return;
    }

    // `streaming: false` is declared on the registry record and has no v2
    // equivalent yet, so the twin stays authoritative for that one capability.
    if (body.stream === true && legacy?.config.streaming === false) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: { message: `Provider "${providerId}" does not support streaming`, code: 'streaming_unsupported' },
      }));
      return;
    }

    if (record) {
      await chatViaProviderService(providerId, record, body, res);
      return;
    }
    await proxyChat(root, legacy, body, res);
  }

  /** Chat through the v2 ProviderService, which resolves the vault credential. */
  async function chatViaProviderService(providerId, record, body, res) {
    const wantsStream = body.stream === true;
    const flavorModule =
      record.config?.registration?.protocol === 'anthropic_messages' ? anthropicFlavor : openaiFlavor;

    let result;
    try {
      result = await providerService.chat({
        providerId,
        model: body.model,
        messages: body.messages ?? [],
        stream: wantsStream,
      });
    } catch (error) {
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599
        ? error.status
        : 502;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: error.message, code: error.code || 'upstream_error' } }));
      return;
    }

    if (!wantsStream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: `gate-${Date.now()}`,
        object: 'chat.completion',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: flavorModule.parseResponseText(result) },
          finish_reason: 'stop',
        }],
      }));
      return;
    }

    // Profile adapters hand back the raw upstream Response; the local-interface
    // adapter hands back an async iterator of already-parsed SSE events.
    if (typeof result?.body?.getReader === 'function') {
      await relayNormalizedSse(result, flavorModule, res);
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    for await (const event of result) {
      const text = typeof event === 'string' ? event : event?.choices?.[0]?.delta?.content;
      if (text) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  }

  const registryMethods = {
    ...createRegistryMethods({ root, getState: () => state, reload, gateHome }),
    ...providerRpc,
    ...environmentRpc,
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
        (pathname === '/v1/backends' && method === 'GET') ||
        (pathname === '/v1/sessions' && (method === 'GET' || method === 'POST')) ||
        /^\/v1\/sessions\/[^/]+$/.test(pathname) ||
        /^\/v1\/sessions\/[^/]+\/messages$/.test(pathname) ||
        (pathname === '/v1/environments' && method === 'GET') ||
        /^\/v1\/environments\/[^/]+\/runs$/.test(pathname) ||
        /^\/v1\/environments\/[^/]+\/runs\/[^/]+\/events$/.test(pathname) ||
        /^\/v1\/environments\/[^/]+\/runs\/[^/]+\/cancel$/.test(pathname) ||
        /^\/v1\/environments\/[^/]+\/runs\/[^/]+\/approve$/.test(pathname) ||
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

      // ─── Backends: native environments that own sessions, models, tools ───

      if (pathname === '/v1/backends' && method === 'GET') {
        res.writeHead(200);
        res.end(JSON.stringify({ backends: await backendManager.describe() }));
        return;
      }

      /** Resolve the backend for a request, or answer 404 and return null. */
      async function resolveBackend(backendId) {
        const id = backendId ?? (await backendManager.list())[0]?.id;
        if (!id) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'No chat backend is attached to this Gate', code: 'no_backend' } }));
          return null;
        }
        try {
          return await backendManager.get(id);
        } catch (error) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: error.message, code: 'unknown_backend' } }));
          return null;
        }
      }

      if (pathname === '/v1/sessions' && method === 'GET') {
        const backend = await resolveBackend(url.searchParams.get('backendId'));
        if (!backend) return;
        const limit = Number(url.searchParams.get('limit')) || undefined;
        const sessions = await backend.listSessions();
        res.writeHead(200);
        res.end(JSON.stringify({ object: 'list', data: limit ? sessions.slice(0, limit) : sessions }));
        return;
      }

      if (pathname === '/v1/sessions' && method === 'POST') {
        const body = (await readJsonBody(req)) ?? {};
        const backend = await resolveBackend(body.backendId);
        if (!backend) return;
        const created = await backend.createSession({ title: body.title, model: body.model });
        res.writeHead(200);
        res.end(JSON.stringify(created));
        return;
      }

      const sessionMessagesMatch = pathname.match(/^\/v1\/sessions\/([^/]+)\/messages$/);
      if (sessionMessagesMatch && method === 'GET') {
        const backend = await resolveBackend(url.searchParams.get('backendId'));
        if (!backend) return;
        const limit = Number(url.searchParams.get('limit')) || undefined;
        const messages = await backend.listMessages(decodeURIComponent(sessionMessagesMatch[1]), limit);
        res.writeHead(200);
        res.end(JSON.stringify({ object: 'list', data: messages }));
        return;
      }

      const sessionMatch = pathname.match(/^\/v1\/sessions\/([^/]+)$/);
      if (sessionMatch && method === 'DELETE') {
        const backend = await resolveBackend(url.searchParams.get('backendId'));
        if (!backend) return;
        await backend.deleteSession(decodeURIComponent(sessionMatch[1]));
        res.writeHead(200);
        res.end(JSON.stringify({ deleted: true }));
        return;
      }

      if (pathname === '/v1/environments' && method === 'GET') {
        const records = await environmentStore.list();
        const environments = [];
        for (const record of records) {
          const status = environmentService.environmentState.get(record.id);
          environments.push(sanitizeEnvironment(record, status));
        }
        res.writeHead(200);
        res.end(JSON.stringify({ environments }));
        return;
      }

      const runStart = pathname.match(/^\/v1\/environments\/([^/]+)\/runs$/);
      if (runStart && method === 'POST') {
        const body = (await readJsonBody(req)) ?? {};
        try {
          const handle = await environmentService.startRun({
            environmentId: decodeURIComponent(runStart[1]),
            ...body,
          });
          res.writeHead(200);
          res.end(JSON.stringify({ runId: handle.runId }));
        } catch (error) {
          res.writeHead(error.code === 'workspace_policy_violation' ? 400 : 409);
          res.end(JSON.stringify({ error: { message: error.message, code: error.code || 'run_failed' } }));
        }
        return;
      }

      const runEvents = pathname.match(/^\/v1\/environments\/([^/]+)\/runs\/([^/]+)\/events$/);
      if (runEvents && method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        try {
          for await (const event of environmentService.events(decodeURIComponent(runEvents[2]))) {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
          }
        } catch (error) {
          res.write(`data: ${JSON.stringify({ type: 'run.failed', payload: { message: error.message } })}\n\n`);
        }
        res.end();
        return;
      }

      const runCancel = pathname.match(/^\/v1\/environments\/([^/]+)\/runs\/([^/]+)\/cancel$/);
      if (runCancel && method === 'POST') {
        const result = await environmentService.cancel(decodeURIComponent(runCancel[2]));
        res.writeHead(200);
        res.end(JSON.stringify(result));
        return;
      }

      const runApprove = pathname.match(/^\/v1\/environments\/([^/]+)\/runs\/([^/]+)\/approve$/);
      if (runApprove && method === 'POST') {
        const body = (await readJsonBody(req)) ?? {};
        const result = await environmentService.approve(
          decodeURIComponent(runApprove[2]),
          body.approvalId,
          body.decision,
        );
        res.writeHead(200);
        res.end(JSON.stringify(result));
        return;
      }

      // /v1/models - provider-owned live or labeled LKG/bootstrap catalogs
      if (pathname === '/v1/models' && method === 'GET') {
        // A backend owns its own catalog (ADR-0003); asking for one by id
        // must return only that catalog, never the Gate's provider list.
        const requestedBackendId = url.searchParams.get('backendId');
        if (requestedBackendId) {
          const backend = await resolveBackend(requestedBackendId);
          if (!backend) return;
          try {
            const models = await backend.listModels();
            res.writeHead(200);
            res.end(JSON.stringify({
              object: 'list',
              data: models.map((model) => ({ ...model, object: 'model', backendId: requestedBackendId })),
            }));
          } catch (error) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: error.message, code: 'backend_error' } }));
          }
          return;
        }

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
        // Every model a native environment can reach, alongside direct providers.
        for (const descriptor of await backendManager.list().catch(() => [])) {
          try {
            const backend = await backendManager.get(descriptor.id);
            for (const model of await backend.listModels()) {
              allModels.push({ ...model, object: 'model', backendId: descriptor.id });
            }
          } catch {
            // a backend that will not start must not blank the model list
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

        // A backend-addressed turn runs inside the native environment, which is
        // what gives it that platform's sessions, tools and approvals.
        if (body.backendId) {
          const backend = await resolveBackend(body.backendId);
          if (!backend) return;
          try {
            const sessionId = body.sessionId
              ?? (await backend.createSession({ title: 'Versutus' })).id;
            const text = lastUserText(body.messages);
            const model = body.model ? parseQualifiedModel(body.model) : undefined;

            if (body.stream === true) {
              await streamBackendTurn(backend, sessionId, { text, model }, res);
              return;
            }

            const result = await backend.sendMessage(sessionId, { text, model });
            const hasContent = Boolean(result?.text && result.text.trim())
              || Boolean(result?.message?.tool_calls?.length);
            if (!hasContent) {
              // Same failure the streaming path guards against: the backend
              // says the turn is done, but there is nothing to show for it.
              res.writeHead(502, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                error: { message: 'The backend completed the turn with no assistant content.', code: 'empty_turn' },
              }));
              return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              id: `gate-${Date.now()}`,
              object: 'chat.completion',
              session_id: sessionId,
              choices: [{ index: 0, message: { role: 'assistant', content: result.text }, finish_reason: 'stop' }],
            }));
          } catch (error) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: error.message, code: 'backend_error' } }));
          }
          return;
        }

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
          await dispatchChat(body.providerId, body, res);
          return;
        }
        if (matches.length > 1) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `Model "${body.model}" is declared by multiple providers`, code: 'ambiguous_model' } }));
          return;
        }
        const providerId = matches[0]?.providerId
          ?? state.providers.find((item) => item.config.models.includes(body?.model))?.id;
        if (!providerId) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `No provider declares model "${body?.model}"`, code: 'unknown_model' } }));
          return;
        }
        await dispatchChat(providerId, body, res);
        return;
      }

      // /p/{provider}/v1/chat/completions - scoped chat
      const scopedChatMatch = pathname.match(/^\/p\/([^/]+)\/v1\/chat\/completions$/);
      if (scopedChatMatch && method === 'POST') {
        const body = await readJsonBody(req);
        await dispatchChat(decodeURIComponent(scopedChatMatch[1]), body ?? {}, res);
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
