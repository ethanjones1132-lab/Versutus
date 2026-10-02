import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { writeFileAtomic } from '../atomic-file.mjs';
import { ProviderStore } from './store.mjs';

const RECEIPT_NAME = 'provider-v2.json';
const RECEIPT_ID = 'provider-v2';

export async function migrateLegacyProviders({ sourceRoot, gateHome }) {
  const store = new ProviderStore(gateHome);
  const receiptPath = join(gateHome, 'state', 'migrations', RECEIPT_NAME);
  // The receipt is a ledger of what has been migrated, not a "done" flag: a
  // registry file added after the first boot is read by nobody otherwise, and
  // it was advertised from the legacy half of the manifest with no diagnostic.
  const receipt = await readReceipt(receiptPath);
  const migrated = new Set(receipt?.providers ?? []);

  let migratedNow = 0;
  let entries = [];
  try {
    entries = await readdir(join(sourceRoot, 'registry'));
  } catch {
    entries = [];
  }

  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length);
    // Two independent reasons to leave an id alone, and both have to hold. The
    // ledger remembers what a previous boot migrated; the store is asked
    // directly so a lost or rolled-back receipt cannot put the v1 values --
    // `enabled: true`, the v1 label, the v1 baseUrl, a catalog-only state --
    // back over a provider the operator has edited since.
    if (migrated.has(id) || await store.get(id)) continue;
    let raw;
    try {
      raw = JSON.parse(await readFile(join(sourceRoot, 'registry', name), 'utf8'));
    } catch {
      continue;
    }
    if (raw?.kind !== 'provider') continue;
    const record = toV2(id, raw);
    try {
      await store.put(record.config, record.state);
    } catch (error) {
      // One record the v2 schema refuses must not decide whether the Gate
      // starts. This throw used to escape into `createGate` and `gate start`,
      // and because the receipt was written only after the loop it was never
      // written at all -- so every later start failed the same way, on a file
      // the migration deliberately leaves in place. The record stays on disk,
      // named, for the operator to fix or delete.
      console.error(
        `gate: legacy registry record ${name} was not migrated (${error.message}); it was left in place and this Gate starts without it`,
      );
      continue;
    }
    migrated.add(id);
    migratedNow += 1;
  }

  if (migratedNow > 0 || !receipt) {
    await mkdir(join(gateHome, 'state', 'migrations'), { recursive: true });
    // Atomic, like every other Gate writer. A bare write leaves a window in
    // which the receipt parses as nothing, and `readReceipt` reads that as
    // "never migrated" -- which is what re-ran the whole migration.
    await writeFileAtomic(receiptPath, JSON.stringify({
      id: RECEIPT_ID,
      migratedAt: new Date().toISOString(),
      providers: [...migrated].sort(),
    }, null, 2) + '\n', { encoding: 'utf8' });
  }

  try {
    return toResult(await store.list());
  } catch (error) {
    // A refused roster is not a reason to refuse to listen. `list()` names a
    // non-ENOENT `readdir` as `provider_roster_unreadable` so the phone can
    // tell "you have none" from "I could not read them"; throwing that out of
    // this function is how a OneDrive lock stopped `createGate` and `gate
    // start` before they bound a port. The Gate starts; the next roster read
    // still reports the failure.
    if (error?.code === 'provider_roster_unreadable') {
      console.error(
        `gate: provider roster could not be listed at start (${error.message}); listening with no providers until it can`,
      );
      return toResult([]);
    }
    throw error;
  }
}

async function readReceipt(receiptPath) {
  try {
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    if (receipt?.id !== RECEIPT_ID || !Array.isArray(receipt.providers)) return undefined;
    return receipt;
  } catch {
    return undefined;
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
