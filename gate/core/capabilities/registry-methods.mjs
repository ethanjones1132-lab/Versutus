import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { describeKinds } from './registry.mjs';
import { looksLikeCredential, setSecret } from './secrets.mjs';

const INSTANCE_ID_PATTERN = /^[a-z0-9-]+$/;
const RESERVED_INSTANCE_IDS = new Set(['registry']);

function assertValidInstanceId(id) {
  if (typeof id !== 'string' || !INSTANCE_ID_PATTERN.test(id)) {
    throw new Error(`instance id must be lowercase alphanumeric with hyphens, got "${id}"`);
  }
  if (RESERVED_INSTANCE_IDS.has(id)) {
    throw new Error(`instance id "${id}" is reserved`);
  }
}

function assertValid(validation) {
  if (!validation.ok) {
    throw new Error(validation.errors.map((e) => `${e.field}: ${e.message}`).join('; '));
  }
}

async function writeInstanceFile(root, id, kind, label, config) {
  const filePath = join(root, 'registry', `${id}.json`);
  await mkdir(join(root, 'registry'), { recursive: true });
  await writeFile(filePath, JSON.stringify({ kind, label, config }, null, 2) + '\n', 'utf8');
}

/**
 * The always-present Gate-core RPC methods for managing the capability
 * registry itself, reserved under the `registry.` prefix. `kind` is
 * immutable once an instance is created — changing it means delete then
 * create.
 *
 * @param {Object} deps
 * @param {string} deps.root - Gate root directory
 * @param {() => {kinds: Map, instances: Array}} deps.getState - current loaded state
 * @param {() => Promise<{kinds: Map, instances: Array}>} deps.reload - re-read from disk, returns the new state
 */
export function createRegistryMethods({ root, getState, reload, gateHome }) {
  let writeQueue = Promise.resolve();
  function serialize(fn) {
    const result = writeQueue.then(fn, fn);
    writeQueue = result.catch(() => {});
    return result;
  }

  return {
    'registry.kinds.list': async () => describeKinds(getState().kinds),

    'registry.instances.list': async () => getState().instances,

    'registry.instances.get': async ({ id } = {}) => {
      const instance = getState().instances.find((i) => i.id === id);
      if (!instance) throw new Error(`instance "${id}" not found`);
      return instance;
    },

    'registry.instances.create': async ({ id, kind, label, config } = {}) => serialize(async () => {
      assertValidInstanceId(id);
      const kindModule = getState().kinds.get(kind);
      if (!kindModule) throw new Error(`unknown kind "${kind}"`);
      if (getState().instances.some((i) => i.id === id)) {
        throw new Error(`instance "${id}" already exists`);
      }
      assertProviderMethodsOwnProviders(kind, 'providers.create');
      assertValid(kindModule.validate(config ?? {}));
      await writeInstanceFile(root, id, kind, label ?? id, config ?? {});
      const state = await reload();
      return state.instances.find((i) => i.id === id);
    }),

    'registry.instances.update': async ({ id, label, config } = {}) => serialize(async () => {
      const existing = getState().instances.find((i) => i.id === id);
      if (!existing) throw new Error(`instance "${id}" not found`);
      assertProviderMethodsOwnProviders(existing.kind, 'providers.update');
      const kindModule = getState().kinds.get(existing.kind);
      assertValid(kindModule.validate(config ?? {}));
      await writeInstanceFile(root, id, existing.kind, label ?? existing.label, config ?? {});
      const state = await reload();
      return state.instances.find((i) => i.id === id);
    }),

    'registry.instances.delete': async ({ id } = {}) => serialize(async () => {
      const existing = getState().instances.find((i) => i.id === id);
      if (!existing) throw new Error(`instance "${id}" not found`);
      // `state.instances` only ever holds registry files now, so this always
      // removes the registry file. A v2 provider record is deleted by
      // providers.delete, which also revokes its credential.
      await unlink(join(root, 'registry', `${id}.json`));
      await reload();
      return { deleted: true };
    }),

    'registry.secrets.set': async ({ refName, value } = {}) => {
      if (typeof refName !== 'string' || !refName) throw new Error('refName must be a non-empty string');
      if (typeof value !== 'string' || !value) throw new Error('value must be a non-empty string');
      // This writes the Gate-root store that legacy registry instances read.
      // A provider credential lives in the Gate-home vault under the provider's
      // own credentialRef, so accepting one here would silently strand the key.
      if (/^provider\//.test(refName)) {
        throw new Error(
          `"${refName}" is a provider credential — set it with providers.auth.setApiKey so the provider's adapter can read it.`,
        );
      }
      // The ref becomes the vault filename, so a key pasted here writes itself
      // into a filename on disk.
      if (looksLikeCredential(refName)) {
        throw new Error(
          'refName looks like a credential. It names the secret, it is not the secret — put the key in "value".',
        );
      }
      await setSecret(root, refName, value);
      return { ok: true, deprecated: true };
    },
  };
}

/**
 * Providers are owned by the providers.* methods, which hold the v2 schema,
 * credential custody and catalog lifecycle. Creating one here produced a second,
 * half-configured record and a key written to a store no adapter reads.
 */
function assertProviderMethodsOwnProviders(kind, method) {
  if (kind !== 'provider') return;
  throw new Error(`providers are managed with ${method}, not the capability registry`);
}
