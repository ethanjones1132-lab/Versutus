#!/usr/bin/env node

import { mkdir, writeFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGate } from './core/server.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Validate provider ID (lowercase alphanumeric + hyphens)
 */
function validateProviderId(id) {
  if (!id || !/^[a-z0-9-]+$/.test(id)) {
    return false;
  }
  return true;
}

/**
 * Validate provider flavor
 */
function validateFlavor(flavor) {
  return ['openai', 'anthropic', 'custom'].includes(flavor);
}

/**
 * Template for new provider.mjs file
 */
function getProviderTemplate(id, flavor) {
  return `/**
 * Provider: ${id}
 * Flavor: ${flavor}
 *
 * Instructions: Fill in the CONFIG object below with your provider details.
 * See PROVIDER_PROMPT.md for detailed instructions.
 */

export const id = '${id}';
export const label = '${id}';

export const config = {
  flavor: '${flavor}',
  baseUrl: 'https://api.example.com/v1',
  apiKeyEnv: '${id.toUpperCase()}_API_KEY',
  models: ['model-name-1', 'model-name-2'],
};
`;
}

/**
 * Handle 'add' command: scaffold a new provider
 */
async function handleAdd(args) {
  const id = args[0];
  const flavorIndex = args.indexOf('--flavor');

  if (!id) {
    console.error('Error: provider id is required');
    console.error('Usage: node gate/cli.mjs add <id> --flavor <openai|anthropic|custom>');
    process.exit(1);
  }

  if (flavorIndex === -1) {
    console.error('Error: --flavor flag is required');
    console.error('Usage: node gate/cli.mjs add <id> --flavor <openai|anthropic|custom>');
    process.exit(1);
  }

  const flavor = args[flavorIndex + 1];

  if (!validateProviderId(id)) {
    console.error(`Error: provider id must be lowercase alphanumeric with hyphens, got "${id}"`);
    process.exit(1);
  }

  if (!validateFlavor(flavor)) {
    console.error(`Error: flavor must be one of openai, anthropic, custom, got "${flavor}"`);
    process.exit(1);
  }

  const providerDir = join(__dirname, 'providers', id);
  const providerFile = join(providerDir, 'provider.mjs');

  // Check if provider already exists
  try {
    await access(providerFile);
    console.error(`Error: provider "${id}" already exists at ${providerDir}`);
    process.exit(1);
  } catch {
    // Provider does not exist, which is what we want
  }

  // Create provider directory and file
  try {
    await mkdir(providerDir, { recursive: true });
    const template = getProviderTemplate(id, flavor);
    await writeFile(providerFile, template, 'utf-8');
    console.log(`Created provider "${id}" at ${providerDir}/provider.mjs`);
  } catch (err) {
    console.error(`Error creating provider: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Handle 'start' command: start the Gate server
 */
async function handleStart() {
  const gateName = process.env.GATE_NAME || 'Versutus Gate';
  const providersDir = join(__dirname, 'providers');

  try {
    console.log(`Starting ${gateName}...`);
    const gate = await createGate({
      providersDir,
      port: 8760,
      name: gateName,
    });

    console.log(`Token: ${gate.token}`);
    console.log(`Listening on port ${gate.port}`);
    console.log(`Manifest: http://127.0.0.1:${gate.port}/.well-known/gateway.json`);

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      console.log('\nShutting down...');
      await gate.close();
      process.exit(0);
    });
  } catch (err) {
    console.error(`Error starting gate: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Main CLI entry point
 */
async function main() {
  const [, , command, ...args] = process.argv;

  if (!command || command === 'help' || command === '-h' || command === '--help') {
    console.log('Versutus Gate CLI');
    console.log('');
    console.log('Usage: node gate/cli.mjs <command> [options]');
    console.log('');
    console.log('Commands:');
    console.log('  add <id> --flavor <openai|anthropic|custom>');
    console.log('    Scaffold a new provider directory with provider.mjs template');
    console.log('');
    console.log('  start');
    console.log('    Start the Gate HTTP server on port 8760');
    console.log('');
    console.log('Environment variables:');
    console.log('  GATE_NAME  - Name of the Gate (defaults to "Versutus Gate")');
    console.log('');
    process.exit(0);
  }

  if (command === 'add') {
    await handleAdd(args);
  } else if (command === 'start') {
    await handleStart();
  } else {
    console.error(`Error: unknown command "${command}"`);
    console.error('Run "node gate/cli.mjs help" for usage');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
