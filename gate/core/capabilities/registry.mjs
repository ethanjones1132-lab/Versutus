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
