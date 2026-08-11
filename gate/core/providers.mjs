import { readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

import { validateProviderConfig } from './config.mjs';

/**
 * Load all provider modules from a directory.
 * Skips invalid providers and logs reasons without crashing.
 *
 * @param {string} root - Directory containing provider subdirectories
 * @returns {Promise<{ providers: Array, skipped: Array }>}
 *   providers: array of { id, label, config, module }, sorted by id
 *   skipped: array of { id, reason }
 */
export async function loadProviders(root) {
  const providers = [];
  const skipped = [];

  // Read directory entries; if dir doesn't exist, return empty
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return { providers, skipped };
  }

  // Process each directory entry (each is a potential provider)
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const id = entry.name;
    const modulePath = join(root, id, 'provider.mjs');
    const moduleUrl = pathToFileURL(modulePath).href;

    // Try to import the provider module
    let module;
    try {
      module = await import(moduleUrl);
    } catch (err) {
      skipped.push({
        id,
        reason: err.message,
      });
      continue;
    }

    // Extract id, label, config from module
    const { id: moduleId, label, config } = module;

    // Validate config
    const validation = validateProviderConfig(id, config);
    if (!validation.ok) {
      skipped.push({
        id,
        reason: validation.error,
      });
      continue;
    }

    // Collect valid provider
    providers.push({
      id: moduleId || id,
      label,
      config,
      module,
    });
  }

  // Sort by id
  providers.sort((a, b) => a.id.localeCompare(b.id));

  return { providers, skipped };
}
