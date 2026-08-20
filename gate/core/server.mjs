import { createServer } from 'node:http';
import { join } from 'node:path';

import { loadCapabilities, describeKinds, resolveManifestInstances } from './capabilities/registry.mjs';
import { buildInstanceHandlers } from './capabilities/dispatch.mjs';
import { createRegistryMethods } from './capabilities/registry-methods.mjs';
import { createGatewayMethods } from './capabilities/gateway-methods.mjs';
import { createTerminalSessions } from './cli-environments/terminal.mjs';
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
/**
 * Relay an OpenAI-shaped SSE stream to the client.
 *
 * Payloads pass through unchanged -- Hermes and the Gate write the same chunk
 * shape, so translating would only add a place to get it wrong. Frames are
 * still split and inspected for two reasons: `[DONE]` is held back so the
 * caller writes exactly one terminator, and deltas are counted so the
 * empty-turn guarantee below survives on this path too. Inspecting is not
 * rewriting; an unparseable frame is forwarded as-is.
 *
 * @returns whether anything the user could see came through.
 */
async function relayOpenAiStream(upstream, res, isDisconnected) {
  const reader = upstream.body?.getReader?.();
  if (!reader) return false;

  const decoder = new TextDecoder();
  let buffer = '';
  let sawContent = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (isDisconnected()) {
      await reader.cancel().catch(() => undefined);
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);

      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trim())
        .join('\n');
      if (!data || data === '[DONE]') continue;

      try {
        const delta = JSON.parse(data)?.choices?.[0]?.delta;
        if (delta?.content || delta?.tool_calls?.length) sawContent = true;
      } catch {
        // Opaque frame: relay it rather than dropping what we cannot read.
      }
      res.write(`data: ${data}\n\n`);
    }
  }
  return sawContent;
}

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
  // A client that walks away must also stop the upstream turn, or the request
  // keeps streaming into a socket nobody is reading.
  res.on('close', () => controller.abort());

  // Token-by-token, when the backend can do it. Hermes sends and streams in one
  // POST, which does not fit the subscribe-then-send shape below, so it is
  // handled as its own path rather than bent into that one.
  if (typeof backend.sendMessageStreaming === 'function') {
    let upstream = null;
    try {
      upstream = await backend.sendMessageStreaming(sessionId, { text, model }, controller.signal);
    } catch {
      // Nothing has been written yet, so the whole-turn path below can still
      // serve this turn. A streaming endpoint that is missing or refuses must
      // not cost the user their reply -- it should cost them only the tokens
      // arriving one at a time.
      upstream = null;
      if (clientDisconnected) {
        res.end();
        return;
      }
    }

    if (upstream) {
      try {
        const sawContent = await relayOpenAiStream(upstream, res, () => clientDisconnected);
        if (!clientDisconnected && !sawContent) {
          res.write(`data: ${JSON.stringify({
            error: { message: 'The backend completed the turn with no assistant content.', code: 'empty_turn' },
          })}\n\n`);
        }
      } catch (error) {
        if (!clientDisconnected) {
          res.write(`data: ${JSON.stringify({ error: { message: error.message, code: 'backend_error' } })}\n\n`);
        }
      } finally {
        if (!clientDisconnected) {
          res.write('data: [DONE]\n\n');
          res.end();
        }
      }
      return;
    }
  }

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

    // A backend whose `streamEvents` is a no-op (Hermes' is, and it is not the
    // only one) finishes the turn with real text that never reached the wire:
    // every delta came from the subscription, and there was no subscription.
    // The turn then renders as an empty bubble that the empty-turn guard below
    // deliberately does not flag, because the content *does* exist. Send it as
    // one delta rather than dropping it -- and only when nothing streamed, so
    // a backend that does emit events is not echoed twice.
    if (!clientDisconnected && !sawContent && result?.text && result.text.trim()) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: result.text } }] })}\n\n`);
    }

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
    terminalSessions: injectedTerminalSessions,
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

  // Shell sessions for the app's Shell tab. See terminal.mjs for why this is a
  // piped shell rather than a PTY — it is what this client actually consumes.
  const terminalSessions = injectedTerminalSessions ?? createTerminalSessions();
  // Open SSE responses, tracked so shutdown can end them. `server.close()`
  // waits for in-flight connections, and a terminal stream never finishes on
  // its own — without this a Gate with the Shell tab open cannot shut down.
  const terminalStreams = new Set();

  const tokenPath = join(root, '.tokens.json');

  // Live, mutable capability state. Recomputed by reload() after any
  // registry.instances.* mutation, so a new/edited/deleted instance is
  // reflected in routing, the manifest, and the RPC dispatch table without
  // restarting the Gate.
  /**
   * RPC method tables.
   *
   * Declared above `computeState()` because the manifest advertises their
   * names (`rpcMethods`), and a manifest built before they exist would ship an
   * empty list — which reads to the app as "this gateway dispatches nothing".
   * Both close over `state`/`reload` lazily, so the order is safe.
   */
  const registryMethods = {
    ...createRegistryMethods({ root, getState: () => state, reload, gateHome }),
    ...providerRpc,
    ...environmentRpc,
  };

  // The Hermes-dialect methods the app's command registry actually sends.
  // Resolution throws rather than writing a response: the RPC dispatcher below
  // owns the reply shape, unlike the REST routes' `resolveBackend`.
  const gatewayMethods = createGatewayMethods({
    async getBackend(backendId, method) {
      if (backendId) return backendManager.get(backendId);
      const entries = await backendManager.list();
      // Same rule as the REST routes: prefer a backend that can answer, rather
      // than whichever happens to be attached first.
      if (method) {
        for (const entry of entries) {
          const backend = await backendManager.get(entry.id).catch(() => null);
          if (backend && typeof backend[method] === 'function') return backend;
        }
      }
      const id = entries[0]?.id;
      if (!id) throw new Error('No chat backend is attached to this Gate');
      return backendManager.get(id);
    },
  });

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
    // Built before the manifest so its keys can be advertised: a capability
    // instance that contributes methods must appear in `rpcMethods` on the
    // same reload that registers it, not on the next restart.
    const dispatch = buildInstanceHandlers(kinds, instances);
    const manifest = buildManifest({
      name,
      version,
      backends,
      providerSnapshots,
      capabilityKinds: describeKinds(kinds),
      capabilityInstances: resolveManifestInstances(kinds, instances),
      rpcMethods: [...new Set([
        ...Object.keys(registryMethods),
        ...Object.keys(gatewayMethods),
        ...dispatch.keys(),
      ])].sort(),
    });
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
      // Readiness is only as good as its last real turn: a catalog probe passes
      // on a provider whose account cannot pay for a completion.
      await providerService.noteChatOutcome(providerId, error).catch(() => undefined);
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599
        ? error.status
        : 502;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: error.message, code: error.code || 'upstream_error' } }));
      return;
    }

    await providerService.noteChatOutcome(providerId, null).catch(() => undefined);

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
        (pathname === '/v1/toolsets' && method === 'GET') ||
        (pathname === '/v1/terminal/stream' && method === 'GET') ||
        (pathname === '/v1/terminal/input' && method === 'POST') ||
        (pathname === '/v1/skills' && method === 'GET') ||
        (pathname === '/v1/bots' && method === 'GET') ||
        // Note the divergence from plain /health, which is unauthenticated:
        // detailed diagnostics expose backend internals and need a token.
        (pathname === '/health/detailed' && method === 'GET') ||
        (pathname === '/v1/jobs' && method === 'GET') ||
        /^\/v1\/jobs\/[^/]+\/(run|pause|resume)$/.test(pathname) ||
        (pathname === '/v1/sessions' && (method === 'GET' || method === 'POST')) ||
        /^\/v1\/sessions\/[^/]+$/.test(pathname) ||
        /^\/v1\/sessions\/[^/]+\/messages$/.test(pathname) ||
        (pathname === '/v1/environments' && method === 'GET') ||
        /^\/v1\/environments\/[^/]+\/runs$/.test(pathname) ||
        /^\/v1\/environments\/[^/]+\/runs\/[^/]+\/events$/.test(pathname) ||
        /^\/v1\/environments\/[^/]+\/runs\/[^/]+\/cancel$/.test(pathname) ||
        /^\/v1\/environments\/[^/]+\/runs\/[^/]+\/approve$/.test(pathname) ||
        (pathname === '/v1/runs' && method === 'POST') ||
        /^\/v1\/runs\/[^/]+$/.test(pathname) ||
        /^\/v1\/runs\/[^/]+\/(events|stop|approval|steer)$/.test(pathname) ||
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
      // The device grant is kept, not just counted: it is the only caller
      // identity the Gate has, and terminal sessions are bound to it.
      const deviceGrant = await deviceTokens.verify(authHeader);
      const isAuthenticated = (await tokenStore.verify(authHeader)) || Boolean(deviceGrant);
      const callerId = deviceGrant?.deviceId ?? 'bootstrap-token';

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

      /**
       * Guard a route that needs one specific backend method.
       *
       * Answers 501 and returns false when the backend cannot serve it. The
       * point is that it always *writes*: the earlier
       * `if (!backend || typeof backend.x !== 'function') return;` shape left
       * the socket hanging with no response whenever the backend existed but
       * lacked the method, because nothing downstream answers either (the
       * `isKnownAuthenticatedRoute` 404 fires far earlier, on the path).
       */
      function requireBackendMethod(backend, name) {
        if (typeof backend?.[name] === 'function') return true;
        res.writeHead(501, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: { message: `This backend does not implement ${name}`, code: 'backend_unsupported' },
        }));
        return false;
      }

      /**
       * Resolve a backend that can actually serve `method`.
       *
       * `resolveBackend` returns the *first* attached backend, which is right
       * when any of them can serve the route. It is wrong for the fronted
       * Hermes surfaces: a Gate with claude/codex/hermes/opencode attached
       * would answer /v1/skills from claude-local and 501, while hermes-local
       * sat there able to serve it. An explicit ?backendId= still wins, so a
       * caller can pin the environment; otherwise pick by capability, exactly
       * as resolveRunBackend already does for runs.
       */
      function readBotId(requestUrl, body) {
        return requestUrl.searchParams.get('bot') || body?.bot || undefined;
      }

      async function resolveConversationBackend(backendId, botId) {
        const backend = await resolveBackend(backendId);
        if (!backend) return null;
        if (!botId) return backend;
        if (typeof backend.forBot !== 'function') {
          res.writeHead(501, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: { message: 'This backend does not implement bots', code: 'backend_unsupported' },
          }));
          return null;
        }
        try {
          return await backend.forBot(botId);
        } catch (error) {
          const code = error.code ?? 'backend_unsupported';
          const status = code === 'unknown_bot' ? 404 : code === 'bot_not_routable' ? 409 : 501;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: error.message, code } }));
          return null;
        }
      }

      async function resolveBackendFor(method) {
        const explicit = url.searchParams.get('backendId');
        if (explicit) {
          const backend = await resolveBackend(explicit);
          if (!backend) return null;
          return requireBackendMethod(backend, method) ? backend : null;
        }
        for (const entry of await backendManager.list()) {
          const backend = await backendManager.get(entry.id).catch(() => null);
          if (backend && typeof backend[method] === 'function') return backend;
        }
        res.writeHead(501, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: { message: `No attached backend implements ${method}`, code: 'backend_unsupported' },
        }));
        return null;
      }

      /**
       * Agentic runs, delegated to whichever backend implements them.
       *
       * The Gate's CLI backends run a turn synchronously and have no notion of
       * a run id, so runs were simply absent and the app correctly reported
       * "Runs not offered". Hermes has the full lifecycle, so fronting it gives
       * the Gate a runs API without reimplementing an agent loop. Paths mirror
       * Hermes exactly, which is also what the app's client already speaks.
       */
      async function resolveRunBackend(backendId) {
        const explicit = backendId ?? url.searchParams.get('backendId');
        if (explicit) {
          const backend = await resolveBackend(explicit);
          if (!backend) return null;
          if (typeof backend.startRun !== 'function') {
            res.writeHead(501, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              error: { message: `Backend "${explicit}" does not implement runs`, code: 'runs_unsupported' },
            }));
            return null;
          }
          return backend;
        }
        // No backend named: pick the first that can actually run one.
        for (const entry of await backendManager.list()) {
          const backend = await backendManager.get(entry.id).catch(() => null);
          if (backend && typeof backend.startRun === 'function') return backend;
        }
        res.writeHead(501, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: { message: 'No attached backend implements runs', code: 'runs_unsupported' },
        }));
        return null;
      }

      if (pathname === '/v1/runs' && method === 'POST') {
        const body = (await readJsonBody(req)) ?? {};
        const backend = await resolveRunBackend(body.backendId);
        if (!backend) return;
        const prompt = typeof body.input === 'string'
          ? body.input
          : lastUserText(Array.isArray(body.input) ? body.input : body.messages);
        if (!prompt) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: "Missing 'input'", code: 'invalid_request' } }));
          return;
        }
        const started = await backend.startRun(prompt, {
          sessionId: body.session_id ?? body.sessionId,
          model: body.model,
        });
        res.writeHead(200);
        res.end(JSON.stringify(started));
        return;
      }

      const runEventsMatch = pathname.match(/^\/v1\/runs\/([^/]+)\/events$/);
      if (runEventsMatch && method === 'GET') {
        const backend = await resolveRunBackend();
        if (!backend) return;
        if (!requireBackendMethod(backend, 'runEvents')) return;
        const upstream = await backend.runEvents(decodeURIComponent(runEventsMatch[1]));
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        // Relay bytes unchanged: the app already parses Hermes run events.
        const reader = upstream.body?.getReader?.();
        if (!reader) { res.end(); return; }
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
        res.end();
        return;
      }

      const runStopMatch = pathname.match(/^\/v1\/runs\/([^/]+)\/stop$/);
      if (runStopMatch && method === 'POST') {
        const backend = await resolveRunBackend();
        if (!backend) return;
        await backend.stopRun(decodeURIComponent(runStopMatch[1]));
        res.writeHead(200);
        res.end(JSON.stringify({ stopped: true }));
        return;
      }

      const runApprovalMatch = pathname.match(/^\/v1\/runs\/([^/]+)\/approval$/);
      if (runApprovalMatch && method === 'POST') {
        const body = (await readJsonBody(req)) ?? {};
        const backend = await resolveRunBackend();
        if (!backend) return;
        if (!requireBackendMethod(backend, 'replyApproval')) return;
        await backend.replyApproval(decodeURIComponent(runApprovalMatch[1]), {
          approved: body.approved,
          feedback: body.feedback,
        });
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      const runStatusMatch = pathname.match(/^\/v1\/runs\/([^/]+)$/);
      if (runStatusMatch && method === 'GET') {
        const backend = await resolveRunBackend();
        if (!backend) return;
        const status = await backend.getRunStatus(decodeURIComponent(runStatusMatch[1]));
        res.writeHead(200);
        res.end(JSON.stringify(status));
        return;
      }

      // Tools, from whichever backend owns them. The Gate has claimed
      // `tools: true` since the adapter declared the capability; this is the
      // route that makes the claim true.
      if (pathname === '/v1/toolsets' && method === 'GET') {
        const backend = await resolveBackendFor('listToolsets');
        if (!backend) return;
        const toolsets = await backend.listToolsets();
        res.writeHead(200);
        res.end(JSON.stringify(toolsets));
        return;
      }

      // Shell. The stream is the session: SSE out, POST in. There is no
      // /resize — the client never called it, and a route that accepts
      // dimensions nothing can apply is the dead-config shape this codebase
      // keeps finding. Restore it alongside a real PTY, not before.
      if (pathname === '/v1/terminal/stream' && method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const send = (event, data) => {
          if (event) res.write(`event: ${event}\n`);
          res.write(`data: ${data}\n\n`);
        };
        let session;
        try {
          session = terminalSessions.open({
            owner: callerId,
            onChunk: (text) => send(null, Buffer.from(text, 'utf8').toString('base64')),
            onExit: (code) => { send('exit', JSON.stringify({ code })); res.end(); },
            onError: (message) => { send('error', JSON.stringify({ error: message })); res.end(); },
          });
        } catch (error) {
          // The client reads an `error` field on the session event as a failed
          // open, so a refusal arrives as a message rather than a dead stream.
          send('session', JSON.stringify({ error: error.message }));
          res.end();
          return;
        }
        send('session', JSON.stringify({ sid: session.sid }));
        terminalStreams.add(res);
        // The stream owns the session's lifetime: a phone that drops off wifi
        // must not leave a shell running on the host forever.
        res.on('close', () => {
          terminalStreams.delete(res);
          session.close();
        });
        return;
      }

      if (pathname === '/v1/terminal/input' && method === 'POST') {
        const body = (await readJsonBody(req)) ?? {};
        const session = terminalSessions.get(body.sid);
        if (session && session.owner !== null && session.owner !== callerId) {
          // Answer as if it does not exist: confirming the id to a caller that
          // does not own it leaks which sessions are live.
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: { message: `unknown terminal session "${body.sid ?? ''}"`, code: 'unknown_session' },
          }));
          return;
        }
        if (!session) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: { message: `unknown terminal session "${body.sid ?? ''}"`, code: 'unknown_session' },
          }));
          return;
        }
        session.write(body.data ?? '');
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // Skills, diagnostics and cron, fronted from the backend. Each was
      // reachable on Hermes all along; the Gate could not offer them because
      // it served no route, so the app's tiles read "Not offered".
      if (pathname === '/v1/skills' && method === 'GET') {
        const backend = await resolveBackendFor('listSkills');
        if (!backend) return;
        res.writeHead(200);
        res.end(JSON.stringify(await backend.listSkills()));
        return;
      }

      if (pathname === '/health/detailed' && method === 'GET') {
        const backend = await resolveBackendFor('healthDetailed');
        if (!backend) return;
        res.writeHead(200);
        res.end(JSON.stringify(await backend.healthDetailed()));
        return;
      }

      if (pathname === '/v1/jobs' && method === 'GET') {
        const backend = await resolveBackendFor('listJobs');
        if (!backend) return;
        res.writeHead(200);
        res.end(JSON.stringify(await backend.listJobs()));
        return;
      }

      if (pathname === '/v1/bots' && method === 'GET') {
        const backend = await resolveBackendFor('listBots');
        if (!backend) return;
        res.writeHead(200);
        res.end(JSON.stringify(await backend.listBots()));
        return;
      }

      const jobActionMatch = pathname.match(/^\/v1\/jobs\/([^/]+)\/(run|pause|resume)$/);
      if (jobActionMatch && method === 'POST') {
        const [, rawJobId, action] = jobActionMatch;
        const jobId = decodeURIComponent(rawJobId);
        const backend = await resolveBackendFor(action === 'run' ? 'runJob' : 'setJobPaused');
        if (!backend) return;
        const result = action === 'run'
          ? await backend.runJob(jobId)
          : await backend.setJobPaused(jobId, action === 'pause');
        res.writeHead(200);
        res.end(JSON.stringify(result ?? { ok: true }));
        return;
      }

      if (pathname === '/v1/sessions' && method === 'GET') {
        const backend = await resolveConversationBackend(url.searchParams.get('backendId'), readBotId(url));
        if (!backend) return;
        const limit = Number(url.searchParams.get('limit')) || undefined;
        const sessions = await backend.listSessions();
        res.writeHead(200);
        res.end(JSON.stringify({ object: 'list', data: limit ? sessions.slice(0, limit) : sessions }));
        return;
      }

      if (pathname === '/v1/sessions' && method === 'POST') {
        const body = (await readJsonBody(req)) ?? {};
        const backend = await resolveConversationBackend(body.backendId, readBotId(url, body));
        if (!backend) return;
        const created = await backend.createSession({ title: body.title, model: body.model });
        res.writeHead(200);
        res.end(JSON.stringify(created));
        return;
      }

      const sessionMessagesMatch = pathname.match(/^\/v1\/sessions\/([^/]+)\/messages$/);
      if (sessionMessagesMatch && method === 'GET') {
        const backend = await resolveConversationBackend(url.searchParams.get('backendId'), readBotId(url));
        if (!backend) return;
        const limit = Number(url.searchParams.get('limit')) || undefined;
        const before = url.searchParams.get('before') || undefined;

        // Paging is done here rather than in the backends: all three read their
        // whole transcript upstream (a file, thread/read, /session/{id}/message)
        // and cannot ask for a slice, so pushing a cursor down would just be a
        // slice wearing a different hat. Doing it here still wins the part that
        // matters to the client -- a bounded, stable page instead of
        // re-downloading the entire window with an ever-larger limit.
        const all = await backend.listMessages(decodeURIComponent(sessionMessagesMatch[1]));
        const cutoff = before ? all.findIndex((message) => message?.id === before) : -1;
        // An unknown cursor must not silently behave like "no cursor" and
        // re-serve the newest page; that would loop the client forever.
        if (before && cutoff === -1) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: `unknown cursor: ${before}` }));
          return;
        }

        const upper = cutoff === -1 ? all.length : cutoff;
        const lower = typeof limit === 'number' ? Math.max(0, upper - limit) : 0;
        const page = all.slice(lower, upper);

        res.writeHead(200);
        res.end(
          JSON.stringify({
            object: 'list',
            data: page,
            hasMore: lower > 0,
            nextBefore: lower > 0 ? (page[0]?.id ?? null) : null,
          }),
        );
        return;
      }

      const sessionMatch = pathname.match(/^\/v1\/sessions\/([^/]+)$/);
      if (sessionMatch && method === 'DELETE') {
        const backend = await resolveConversationBackend(url.searchParams.get('backendId'), readBotId(url));
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
            // The streaming branch above may already have sent headers.
            if (res.headersSent) {
              res.end();
              return;
            }
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
          const backend = await resolveConversationBackend(body.backendId, readBotId(url, body));
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
        const handler = registryMethods[rpcMethod] ?? gatewayMethods[rpcMethod] ?? state.dispatch.get(rpcMethod);
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
      // This is the last line of defence, so it must not be able to throw.
      // A streaming route (SSE chat, run events, terminal) has already
      // committed its status line by the time an error reaches here; calling
      // writeHead again raises ERR_HTTP_HEADERS_SENT *inside this catch*,
      // where nothing handles it -- which took the whole Gate down whenever a
      // client asked about a session that no longer existed.
      if (res.headersSent) {
        res.end();
        return;
      }
      try {
        res.writeHead(500);
        res.end(JSON.stringify({
          error: 'Internal Server Error',
          message: err.message,
        }));
      } catch {
        res.end();
      }
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
      // Kill any live shells before the listener goes away, or they outlive it,
      // and end their streams or `server.close()` waits on them forever.
      terminalSessions.closeAll();
      for (const stream of [...terminalStreams]) {
        terminalStreams.delete(stream);
        try { stream.end(); } catch { /* already gone */ }
      }
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
