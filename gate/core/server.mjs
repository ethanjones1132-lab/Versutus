import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { loadProviders } from './providers.mjs';
import { buildManifest } from './manifest.mjs';
import { TokenStore } from './tokens.mjs';

/**
 * Create and configure a Versutus Gate HTTP server
 * @param {Object} config
 * @param {string} config.providersDir - Directory containing provider modules
 * @param {number} [config.port=0] - Port to listen on (0 = OS chooses)
 * @param {string} [config.name='Versutus Gate'] - Gateway name
 * @param {string} [config.version] - Gateway version
 * @returns {Promise<Object>} Gate object with token, providers, port, listen(), close()
 */
export async function createGate(config = {}) {
  const {
    providersDir,
    port = 0,
    name = 'Versutus Gate',
    version,
  } = config;

  // Load providers from the specified directory
  const { providers } = await loadProviders(providersDir);

  // Initialize token store
  const tokenPath = join(tmpdir(), 'versutus-gate-tokens.json');
  const tokenStore = new TokenStore(tokenPath);
  const token = await tokenStore.ensureToken();

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

    try {
      // Health endpoint (unauthenticated)
      if (pathname === '/health' && method === 'GET') {
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

      // Check if route exists before requiring authentication
      // This allows us to return 404 for unknown routes
      const isKnownAuthenticatedRoute =
        (pathname === '/v1/models' && method === 'GET') ||
        /^\/p\/[^\/]+\/v1\/models$/.test(pathname);

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
      const isAuthenticated = await tokenStore.verify(authHeader);

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
