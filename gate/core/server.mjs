import { createServer } from 'node:http';
import { join } from 'node:path';

import { loadProviders } from './providers.mjs';
import { buildManifest } from './manifest.mjs';
import { TokenStore } from './tokens.mjs';
import { PairingStore } from './pairing.mjs';
import { DeviceTokenStore } from './device-tokens.mjs';
import { verifySignedAccessRequest } from './signature.mjs';
import * as openaiFlavor from '../flavors/openai.mjs';
import * as anthropicFlavor from '../flavors/anthropic.mjs';

const FLAVOR_MODULES = { openai: openaiFlavor, anthropic: anthropicFlavor };

async function proxyChat(provider, requestBody, res) {
  const flavorModule = FLAVOR_MODULES[provider.config.flavor];
  if (!flavorModule) {
    res.writeHead(501, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: { message: `Chat is not implemented for flavor "${provider.config.flavor}"`, code: 'flavor_not_implemented' },
    }));
    return;
  }

  const wantsStream = requestBody.stream === true;
  if (wantsStream && provider.config.capabilities?.streaming !== true) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: { message: `Provider "${provider.id}" does not support streaming`, code: 'streaming_unsupported' },
    }));
    return;
  }

  const apiKey = process.env[provider.config.apiKeyEnv] ?? '';
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
 * @param {string} config.root - Root directory for the Gate (providers and token store location)
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
  } = config;

  const providersDir = join(root, 'providers');
  const tokenPath = join(root, '.tokens.json');

  // Load providers from the specified directory
  const { providers } = await loadProviders(providersDir);

  // Initialize token store
  const tokenStore = new TokenStore(tokenPath);
  const token = await tokenStore.ensureToken();

  const pairing = new PairingStore(join(root, '.pairing.json'));
  const deviceTokens = new DeviceTokenStore(join(root, '.device-tokens.json'));
  const replayCache = new Set();

  // Build manifest
  const manifest = buildManifest({
    name,
    version,
    providers,
  });

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
        res.end(JSON.stringify(manifest));
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
        /^\/p\/[^/]+\/v1\/models$/.test(pathname) ||
        (pathname === '/v1/chat/completions' && method === 'POST') ||
        /^\/p\/[^/]+\/v1\/chat\/completions$/.test(pathname);

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

      // /v1/models - all provider models
      if (pathname === '/v1/models' && method === 'GET') {
        const allModels = [];
        for (const provider of providers) {
          const models = provider.config.models || [];
          for (const modelId of models) {
            allModels.push({
              id: modelId,
              provider: provider.id,
              label: modelId,
              object: 'model',
            });
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
        const provider = providers.find((p) => p.id === providerId);

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
        const body = await readJsonBody(req);
        const provider = providers.find((p) => p.config.models.includes(body?.model));
        if (!provider) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `No provider declares model "${body?.model}"`, code: 'unknown_model' } }));
          return;
        }
        await proxyChat(provider, body ?? {}, res);
        return;
      }

      // /p/{provider}/v1/chat/completions - scoped chat
      const scopedChatMatch = pathname.match(/^\/p\/([^/]+)\/v1\/chat\/completions$/);
      if (scopedChatMatch && method === 'POST') {
        const providerId = decodeURIComponent(scopedChatMatch[1]);
        const provider = providers.find((p) => p.id === providerId);
        if (!provider) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `Unknown provider "${providerId}"`, code: 'unknown_provider' } }));
          return;
        }
        const body = await readJsonBody(req);
        await proxyChat(provider, body ?? {}, res);
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
    providers,
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
