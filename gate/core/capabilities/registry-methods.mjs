import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { describeKinds } from './registry.mjs';
import { setSecret } from './secrets.mjs';

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
export function createRegistryMethods({ root, getState, reload }) {
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
      assertValid(kindModule.validate(config ?? {}));
      await writeInstanceFile(root, id, kind, label ?? id, config ?? {});
      const state = await reload();
      return state.instances.find((i) => i.id === id);
    }),

    'registry.instances.update': async ({ id, label, config } = {}) => serialize(async () => {
      const existing = getState().instances.find((i) => i.id === id);
      if (!existing) throw new Error(`instance "${id}" not found`);
      const kindModule = getState().kinds.get(existing.kind);
      assertValid(kindModule.validate(config ?? {}));
      await writeInstanceFile(root, id, existing.kind, label ?? existing.label, config ?? {});
      const state = await reload();
      return state.instances.find((i) => i.id === id);
    }),

    'registry.instances.delete': async ({ id } = {}) => serialize(async () => {
      const existing = getState().instances.find((i) => i.id === id);
      if (!existing) throw new Error(`instance "${id}" not found`);
      await unlink(join(root, 'registry', `${id}.json`));
      await reload();
      return { deleted: true };
    }),

    'registry.secrets.set': async ({ refName, value } = {}) => {
      if (typeof refName !== 'string' || !refName) throw new Error('refName must be a non-empty string');
      if (typeof value !== 'string' || !value) throw new Error('value must be a non-empty string');
      await setSecret(root, refName, value);
      return { ok: true };
    },
  };
}
