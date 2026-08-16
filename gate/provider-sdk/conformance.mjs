import { ManifestClient } from '../core/providers/local/manifest-client.mjs';
import { createLocalProviderAdapter } from '../core/providers/local/adapter.mjs';

export async function runConformance(origin) {
  const checked = [];
  const manifestUrl = new URL('/.well-known/versutus-provider.json', origin).href;
  const client = new ManifestClient({ manifestUrl });
  const manifest = await client.discover();
  if (manifest.spec !== 'versutus-provider/v1') {
    throw new Error('conformance failed: incompatible spec');
  }
  checked.push('manifest');

  const adapter = await createLocalProviderAdapter({
    manifestUrl,
    providerId: manifest.id ?? 'conformance',
    credential: 'conformance',
  });

  const health = await adapter.health();
  if (health.state !== 'ready') {
    throw new Error('conformance failed: health is not ready');
  }
  checked.push('health');

  const models = await adapter.listModels();
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error('conformance failed: models catalog is empty');
  }
  checked.push('models');

  const chat = await adapter.chat({
    model: models[0].id,
    messages: [{ role: 'user', content: 'ping' }],
  });
  if (!chat?.choices?.[0]?.message) {
    throw new Error('conformance failed: chat did not return a message');
  }
  checked.push('chat');

  return { ok: true, checked, manifest };
}
