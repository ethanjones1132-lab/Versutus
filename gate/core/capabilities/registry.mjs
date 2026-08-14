import { readdir, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const REQUIRED_KIND_EXPORTS = [
  'kind', 'label', 'family', 'configFields', 'validate', 'toManifestEntry', 'createHandlers',
];

/**
 * Load all capability kind modules from a directory (one subdirectory per
 * kind, each containing kind.mjs). Skips invalid kinds and logs reasons
 * without crashing — the same discipline loadProviders() used.
 *
 * @param {string} root
 * @returns {Promise<{ kinds: Map<string, object>, skipped: Array<{id, reason}> }>}
 */
export async function loadKinds(root) {
  const kinds = new Map();
  const skipped = [];

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return { kinds, skipped };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const dirId = entry.name;
    const modulePath = join(root, dirId, 'kind.mjs');
    const moduleUrl = pathToFileURL(modulePath).href;

    let module;
    try {
      module = await import(moduleUrl);
    } catch (err) {
      skipped.push({ id: dirId, reason: err.message });
      continue;
    }

    const definition = module.default;
    if (!definition || typeof definition !== 'object') {
      skipped.push({ id: dirId, reason: 'kind.mjs must have a default export' });
      continue;
    }

    const missing = REQUIRED_KIND_EXPORTS.filter((key) => definition[key] === undefined);
    if (missing.length > 0) {
      skipped.push({ id: dirId, reason: `kind.mjs default export is missing: ${missing.join(', ')}` });
      continue;
    }

    kinds.set(definition.kind || dirId, definition);
  }

  return { kinds, skipped };
}

const RESERVED_INSTANCE_IDS = new Set(['registry']);

/**
 * Load all capability instance configs from a directory (one <id>.json file
 * per instance), cross-validated against already-loaded kinds. Skips
 * invalid instances and logs reasons without crashing.
 *
 * @param {string} root
 * @param {Map<string, object>} kinds - result of loadKinds()
 * @returns {Promise<{ instances: Array, skipped: Array<{id, reason}> }>}
 */
export async function loadInstances(root, kinds) {
  const instances = [];
  const skipped = [];

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return { instances, skipped };
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const id = entry.name.slice(0, -'.json'.length);

    if (RESERVED_INSTANCE_IDS.has(id)) {
      skipped.push({ id, reason: `instance id "${id}" is reserved for built-in registry methods` });
      continue;
    }

    let raw;
    try {
      raw = await readFile(join(root, entry.name), 'utf8');
    } catch (err) {
      skipped.push({ id, reason: err.message });
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      skipped.push({ id, reason: `invalid JSON: ${err.message}` });
      continue;
    }

    if (parsed?.schemaVersion === 2 || parsed?.kind === 'cli-environment') {
      skipped.push({ id, reason: 'v2 provider and CLI environment records belong in Gate home, not the source registry' });
      continue;
    }

    const { kind, label, config } = parsed ?? {};
    const kindModule = kinds.get(kind);
    if (!kindModule) {
      skipped.push({ id, reason: `unknown kind "${kind}"` });
      continue;
    }

    let validation;
    try {
      validation = kindModule.validate(config ?? {});
    } catch (err) {
      skipped.push({ id, reason: `validate() threw: ${err.message}` });
      continue;
    }

    if (!validation.ok) {
      skipped.push({ id, reason: validation.errors.map((e) => `${e.field}: ${e.message}`).join('; ') });
      continue;
    }

    instances.push({ id, kind, label: label ?? id, config: config ?? {} });
  }

  instances.sort((a, b) => a.id.localeCompare(b.id));
  return { instances, skipped };
}

/** Wire-safe kind catalog: drops the function properties, keeps the schema. */
export function describeKinds(kinds) {
  return [...kinds.values()].map((k) => ({
    id: k.kind,
    label: k.label,
    family: k.family,
    configFields: k.configFields,
  }));
}

/**
 * A kind declares its commands with LOCAL method names, since it is authored
 * once, before any instance of it exists. buildInstanceHandlers registers those
 * handlers as `<instance-id>.<localName>`, and the app calls whatever `method`
 * we advertise verbatim — so qualify them here.
 *
 * Returns undefined (not []) when the kind declares no usable commands, so the
 * manifest omits the key entirely rather than carrying an empty array.
 */
function qualifyCommands(instance, kindModule) {
  if (!Array.isArray(kindModule.commands)) return undefined;

  const qualified = [];
  for (const command of kindModule.commands) {
    const local = command?.method;
    if (typeof local !== 'string' || !local || local.includes('.')) {
      // Advertising `<id>.undefined` or a double-prefixed `<id>.<id>.<name>`
      // would put a command in the palette that matches no dispatch key and
      // fails on every invocation — drop it loudly instead.
      console.error(
        `resolveManifestInstances: instance "${instance.id}" skipped a command with an invalid method ${JSON.stringify(local)} — expected a non-empty local handler name with no dot (the instance id is prefixed automatically).`,
      );
      continue;
    }
    try {
      // Deep copy: the kind module is a shared, long-lived import, so a shallow
      // spread would leave nested fields like `params` aliased across every
      // instance of that kind and back into the module itself.
      qualified.push({ ...structuredClone(command), method: `${instance.id}.${local}` });
    } catch (err) {
      console.error(
        `resolveManifestInstances: instance "${instance.id}" skipped command "${local}" — it is not serializable: ${err.message}`,
      );
    }
  }

  return qualified.length > 0 ? qualified : undefined;
}

/** Wire-safe instance list: each instance's manifest contribution, resolved via its kind. */
export function resolveManifestInstances(kinds, instances) {
  return instances.map((instance) => {
    const kindModule = kinds.get(instance.kind);
    let manifestEntry;
    try {
      manifestEntry = kindModule.toManifestEntry(instance);
    } catch (err) {
      console.error(`resolveManifestInstances: toManifestEntry() threw for instance "${instance.id}": ${err.message}`);
      return null;
    }
    const commands = qualifyCommands(instance, kindModule);

    return {
      id: instance.id,
      kind: instance.kind,
      label: instance.label,
      family: kindModule.family,
      manifestEntry,
      ...(commands ? { commands } : {}),
    };
  }).filter((entry) => entry !== null);
}

/** Load kinds and instances together from a Gate root directory. */
export async function loadCapabilities(root) {
  const { kinds, skipped: skippedKinds } = await loadKinds(join(root, 'core', 'capabilities'));
  const { instances, skipped: skippedInstances } = await loadInstances(join(root, 'registry'), kinds);
  return { kinds, instances, skippedKinds, skippedInstances };
}
