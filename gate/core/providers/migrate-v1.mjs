import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ProviderStore } from './store.mjs';

const RECEIPT_NAME = 'provider-v2.json';

export async function migrateLegacyProviders({ sourceRoot, gateHome }) {
  const store = new ProviderStore(gateHome);
  const receiptPath = join(gateHome, 'state', 'migrations', RECEIPT_NAME);

  if (await receiptExists(receiptPath)) {
    return toResult(await store.list());
  }

  const providers = [];
  let entries = [];
  try {
    entries = await readdir(join(sourceRoot, 'registry'));
  } catch {
    entries = [];
  }

  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length);
    let raw;
    try {
      raw = JSON.parse(await readFile(join(sourceRoot, 'registry', name), 'utf8'));
    } catch {
      continue;
    }
    if (raw?.kind !== 'provider') continue;
    const record = toV2(id, raw);
    await store.put(record.config, record.state);
    providers.push(record);
  }

  await mkdir(join(gateHome, 'state', 'migrations'), { recursive: true });
  await writeFile(
    receiptPath,
    JSON.stringify({
      id: 'provider-v2',
      migratedAt: new Date().toISOString(),
      providers: providers.map((record) => record.config.id),
    }, null, 2) + '\n',
    'utf8',
  );

  return toResult(providers.map((record) => ({ config: record.config, state: record.state })));
}

async function receiptExists(receiptPath) {
  try {
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    return receipt?.id === 'provider-v2';
  } catch {
    return false;
  }
}

function toResult(records) {
  return {
    providers: records.map((record) => ({
      ...record.config,
      catalog: record.state?.catalog ?? { source: 'legacy_bootstrap' },
    })),
  };
}

function toV2(id, raw) {
  const flavor = raw.config?.flavor;
  const protocol = flavor === 'anthropic' ? 'anthropic_messages' : 'openai_chat';
  const haystack = `${id} ${raw.label ?? ''} ${raw.config?.baseUrl ?? ''}`;
  const providerType = /nvidia/i.test(haystack) ? 'nvidia-nim' : flavor || 'openai';
  const models = Array.isArray(raw.config?.models) ? raw.config.models : [];
  return {
    config: {
      schemaVersion: 2,
      kind: 'provider',
      id,
      label: raw.label ?? id,
      providerType,
      enabled: true,
      registration: {
        mode: 'api_key',
        protocol,
        baseUrl: raw.config?.baseUrl ?? '',
        credentialRef: `provider/${id}/api-key`,
      },
      catalogPolicy: { ttlSeconds: 300, allowLastKnownGood: true },
      requestPolicy: { timeoutMs: 120000 },
    },
    state: {
      legacyApiKeyEnv: raw.config?.apiKeyEnv,
      catalog: {
        source: 'legacy_bootstrap',
        state: 'stale',
        generation: 0,
        models: models.map((modelId) => ({ providerId: id, id: modelId, available: true })),
      },
    },
  };
}
