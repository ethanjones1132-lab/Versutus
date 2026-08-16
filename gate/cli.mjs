#!/usr/bin/env node

import { mkdir, writeFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createGate } from './core/server.mjs';
import { PairingStore } from './core/pairing.mjs';
import { DeviceTokenStore } from './core/device-tokens.mjs';
import { validateId, buildInstanceConfigTemplate, getKindTemplate } from './core/cli-helpers.mjs';
import { resolveGateHome } from './core/paths.mjs';
import { ProviderStore } from './core/providers/store.mjs';
import { migrateLegacyProviders } from './core/providers/migrate-v1.mjs';
import { CliEnvironmentStore } from './core/cli-environments/store.mjs';
import { CliAdapterRegistry } from './core/cli-environments/adapter-registry.mjs';
import { buildTaskDefinition } from './core/service/windows-task.mjs';
import { acquireInstanceLock } from './core/service/instance-lock.mjs';
import { doctor } from './core/service/doctor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Load a kind module by id, or null if it doesn't exist / fails to import.
 */
async function loadKindModule(kindId) {
  const modulePath = join(__dirname, 'core', 'capabilities', kindId, 'kind.mjs');
  try {
    const module = await import(pathToFileURL(modulePath).href);
    return module.default ?? null;
  } catch (err) {
    console.error(`(kind "${kindId}" failed to load: ${err.message})`);
    return null;
  }
}

/**
 * Handle 'add' command: scaffold a new capability instance of an existing kind
 */
async function handleAdd(args) {
  const id = args[0];
  const kindIndex = args.indexOf('--kind');

  if (!id) {
    console.error('Error: instance id is required');
    console.error('Usage: node gate/cli.mjs add <id> --kind <kind-id>');
    process.exit(1);
  }

  if (kindIndex === -1) {
    console.error('Error: --kind flag is required');
    console.error('Usage: node gate/cli.mjs add <id> --kind <kind-id>');
    process.exit(1);
  }

  const kindId = args[kindIndex + 1];

  if (!validateId(id)) {
    console.error(`Error: instance id must be lowercase alphanumeric with hyphens, got "${id}"`);
    process.exit(1);
  }

  if (!validateId(kindId)) {
    console.error(`Error: kind id must be lowercase alphanumeric with hyphens, got "${kindId}"`);
    process.exit(1);
  }

  const kindModule = await loadKindModule(kindId);
  if (!kindModule) {
    console.error(`Error: kind "${kindId}" not found at gate/core/capabilities/${kindId}/kind.mjs`);
    console.error(`Run "node gate/cli.mjs add-kind ${kindId} --label \\"<label>\\" --family <family>" first, or check the kind id.`);
    process.exit(1);
  }

  const label = id.charAt(0).toUpperCase() + id.slice(1);

  if (kindId === 'provider') {
    const gateHome = resolveGateHome();
    const store = new ProviderStore(gateHome);
    if (await store.get(id)) {
      console.error(`Error: provider "${id}" already exists in Gate home`);
      process.exit(1);
    }
    try {
      await store.put({
        schemaVersion: 2,
        kind: 'provider',
        id,
        label,
        providerType: 'openai',
        enabled: true,
        registration: {
          mode: 'api_key',
          protocol: 'openai_chat',
          baseUrl: 'https://api.openai.com/v1',
          credentialRef: `provider/${id}/api-key`,
        },
        catalogPolicy: { ttlSeconds: 300, allowLastKnownGood: true },
        requestPolicy: { timeoutMs: 120000 },
      }, {
        catalog: { source: 'legacy_bootstrap', state: 'stale', generation: 0, models: [] },
      });
      console.log(`Created provider "${id}" in ${gateHome}`);
    } catch (err) {
      console.error(`Error creating provider: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  const registryDir = join(__dirname, 'registry');
  const instanceFile = join(registryDir, `${id}.json`);

  // Check if instance already exists
  try {
    await access(instanceFile);
    console.error(`Error: instance "${id}" already exists at ${instanceFile}`);
    process.exit(1);
  } catch {
    // Instance does not exist, which is what we want
  }

  const config = buildInstanceConfigTemplate(kindModule.configFields);
  const template = JSON.stringify({ kind: kindId, label, config }, null, 2) + '\n';

  // Create registry instance file
  try {
    await mkdir(registryDir, { recursive: true });
    await writeFile(instanceFile, template, 'utf-8');
    console.log(`Created instance "${id}" at ${instanceFile}`);
  } catch (err) {
    console.error(`Error creating instance: ${err.message}`);
    process.exit(1);
  }
}

async function handleAddEnvironment(args) {
  const id = args[0];
  const adapterIndex = args.indexOf('--adapter');
  const pathIndex = args.indexOf('--path');
  const rootIndex = args.indexOf('--root');

  if (!id || adapterIndex === -1 || pathIndex === -1) {
    console.error('Usage: node gate/cli.mjs add-environment <id> --adapter <adapter-id> --path <executable> [--root <workspace>]');
    process.exit(1);
  }

  if (!validateId(id)) {
    console.error(`Error: environment id must be lowercase alphanumeric with hyphens, got "${id}"`);
    process.exit(1);
  }

  const adapterId = args[adapterIndex + 1];
  const executablePath = args[pathIndex + 1];
  const workspaceRoot = rootIndex === -1 ? process.cwd() : args[rootIndex + 1];
  const registry = new CliAdapterRegistry();
  let adapter;
  try {
    adapter = registry.get(adapterId);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  const probe = await adapter.probe(executablePath);
  if (probe.state === 'not_installed') {
    console.error(`Error: executable not found at ${executablePath}`);
    process.exit(1);
  }
  if (probe.state === 'incompatible') {
    console.error(`Error: ${probe.message ?? 'incompatible CLI version'}`);
    process.exit(1);
  }

  const gateHome = resolveGateHome();
  const store = new CliEnvironmentStore(gateHome);
  if (await store.get(id)) {
    console.error(`Error: environment "${id}" already exists in Gate home`);
    process.exit(1);
  }

  const label = id.charAt(0).toUpperCase() + id.slice(1);
  await store.put({
    schemaVersion: 1,
    kind: 'cli-environment',
    id,
    label,
    adapterId,
    executable: { path: executablePath },
    protocolPreference: Object.keys(adapter.protocolVersions),
    versionPolicy: { supported: adapter.supportedCliVersions, adapterRevision: adapter.adapterRevision },
    providerRefs: [],
    workspacePolicy: {
      roots: [workspaceRoot],
      defaultRoot: workspaceRoot,
      defaultSandbox: 'read_only',
      allowAdditionalRoots: false,
    },
    lifecycle: {
      startup: 'on_demand',
      idleTimeoutSeconds: 300,
      maxConcurrentRuns: 1,
    },
    enabled: true,
  });

  console.log(`Created CLI environment "${id}" in ${gateHome}`);
  console.log(`adapter=${adapterId} version=${probe.cliVersion ?? 'unknown'} protocol=${probe.protocol ?? 'unknown'} state=${probe.state}`);
}

/**
 * Handle 'add-kind' command: scaffold a new capability kind module
 */
async function handleAddKind(args) {
  const kindId = args[0];
  const labelIndex = args.indexOf('--label');
  const familyIndex = args.indexOf('--family');

  if (!kindId) {
    console.error('Error: kind id is required');
    console.error('Usage: node gate/cli.mjs add-kind <kind-id> --label "<label>" --family <family>');
    process.exit(1);
  }

  if (labelIndex === -1 || familyIndex === -1) {
    console.error('Error: --label and --family flags are required');
    console.error('Usage: node gate/cli.mjs add-kind <kind-id> --label "<label>" --family <family>');
    process.exit(1);
  }

  const label = args[labelIndex + 1];
  const family = args[familyIndex + 1];

  if (!validateId(kindId)) {
    console.error(`Error: kind id must be lowercase alphanumeric with hyphens, got "${kindId}"`);
    process.exit(1);
  }

  if (!label) {
    console.error('Error: --label must be a non-empty string');
    process.exit(1);
  }

  if (!family) {
    console.error('Error: --family must be a non-empty string');
    process.exit(1);
  }

  const kindDir = join(__dirname, 'core', 'capabilities', kindId);
  const kindFile = join(kindDir, 'kind.mjs');

  // Check if kind already exists
  try {
    await access(kindFile);
    console.error(`Error: kind "${kindId}" already exists at ${kindFile}`);
    process.exit(1);
  } catch {
    // Kind does not exist, which is what we want
  }

  try {
    await mkdir(kindDir, { recursive: true });
    const template = getKindTemplate(kindId, label, family);
    await writeFile(kindFile, template, 'utf-8');
    console.log(`Created kind "${kindId}" at ${kindFile}`);
  } catch (err) {
    console.error(`Error creating kind: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Handle 'start' command: start the Gate server
 */
async function handleStart() {
  const gateName = process.env.GATE_NAME || 'Versutus Gate';

  try {
    console.log(`Starting ${gateName}...`);
    const gateHome = resolveGateHome();
    const lock = await acquireInstanceLock(gateHome);
    process.on('exit', () => { void lock.release(); });
    await migrateLegacyProviders({ sourceRoot: __dirname, gateHome });
    const gate = await createGate({
      root: __dirname,
      port: 8760,
      name: gateName,
      gateHome,
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
 * Handle 'pair' command: manage device pairing and tokens
 */
async function handlePair(args) {
  const [sub, ...rest] = args;
  const pairing = new PairingStore(join(__dirname, '.pairing.json'));
  const deviceTokens = new DeviceTokenStore(join(__dirname, '.device-tokens.json'));

  if (sub === 'open') {
    const minutesIndex = rest.indexOf('--minutes');
    const minutes = minutesIndex >= 0 ? Number(rest[minutesIndex + 1]) : 5;
    if (!Number.isFinite(minutes) || minutes <= 0) {
      console.error('Error: --minutes must be a positive number');
      process.exit(1);
    }
    await pairing.openWindow(minutes * 60_000);
    console.log(`Pairing window open for ${minutes} minute(s). The next device to connect is granted automatically.`);
    return;
  }

  if (sub === 'approve') {
    const requestId = rest[0];
    if (!requestId) {
      console.error('Error: Usage: node gate/cli.mjs pair approve <requestId>');
      process.exit(1);
    }
    const entry = await pairing.takePending(requestId);
    if (!entry) {
      console.error(`Error: No pending request "${requestId}". Run "pair list" to see open requests.`);
      process.exit(1);
    }
    const token = await deviceTokens.issue(entry.deviceId, { role: entry.role, scopes: entry.scopes });
    console.log(`Approved device ${entry.deviceId}. Token: ${token}`);
    return;
  }

  if (sub === 'revoke') {
    const deviceId = rest[0];
    if (!deviceId) {
      console.error('Error: Usage: node gate/cli.mjs pair revoke <deviceId>');
      process.exit(1);
    }
    const found = await deviceTokens.revoke(deviceId);
    console.log(found ? `Revoked device ${deviceId}.` : `No device "${deviceId}" on file.`);
    return;
  }

  if (sub === 'list') {
    const pending = await pairing.listPending();
    const devices = await deviceTokens.list();
    console.log('Pending requests:');
    for (const entry of pending) console.log(`  ${entry.requestId}  device=${entry.deviceId}  role=${entry.role}`);
    if (pending.length === 0) console.log('  (none)');
    console.log('Paired devices:');
    for (const entry of devices) console.log(`  ${entry.deviceId}  role=${entry.role}  ${entry.revoked ? '(revoked)' : ''}`);
    if (devices.length === 0) console.log('  (none)');
    return;
  }

  console.error('Usage: node gate/cli.mjs pair <open|approve|revoke|list>');
  process.exit(1);
}

async function handleService(args) {
  const sub = args[0];
  const user = process.env.USERNAME ? `${process.env.USERDOMAIN || 'USER'}\\${process.env.USERNAME}` : process.env.USER;
  const gateHome = resolveGateHome();
  const definition = buildTaskDefinition({
    user,
    executable: join(__dirname, 'cli.mjs'),
    gateHome,
  });
  if (sub === 'install') {
    console.log(`Would install Scheduled Task ${definition.name} for ${definition.userId}`);
    return;
  }
  if (sub === 'status') {
    console.log(doctor({ user, gateHome, listen: 'http://127.0.0.1:8760', pid: process.pid }));
    return;
  }
  if (sub === 'start' || sub === 'stop' || sub === 'uninstall') {
    console.log(`service ${sub}: ${definition.name}`);
    return;
  }
  console.error('Usage: node gate/cli.mjs service <install|start|stop|status|uninstall>');
  process.exit(1);
}

async function handleDoctor() {
  const user = process.env.USERNAME ? `${process.env.USERDOMAIN || 'USER'}\\${process.env.USERNAME}` : process.env.USER;
  console.log(doctor({
    user,
    gateHome: resolveGateHome(),
    listen: 'http://127.0.0.1:8760',
    pid: process.pid,
  }));
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
    console.log('  add <id> --kind <kind-id>');
    console.log('    Scaffold a new capability instance in gate/registry/<id>.json,');
    console.log('    pre-filled from the kind\'s declared config fields');
    console.log('');
    console.log('  add-kind <kind-id> --label "<label>" --family <family>');
    console.log('    Scaffold a new capability kind module at');
    console.log('    gate/core/capabilities/<kind-id>/kind.mjs');
    console.log('');
    console.log('  add-environment <id> --adapter <adapter-id> --path <executable> [--root <workspace>]');
    console.log('    Register a CLI environment (hermes, codex, claude-code, opencode) in Gate home');
    console.log('');
    console.log('  start');
    console.log('    Start the Gate HTTP server on port 8760');
    console.log('');
    console.log('  pair <open|approve|revoke|list>');
    console.log('    Manage device pairing and access tokens');
    console.log('    open [--minutes N]  Open the pairing window (default 5 minutes)');
    console.log('    approve <requestId> Approve a pending access request');
    console.log('    revoke <deviceId>   Revoke a device\'s access token');
    console.log('    list                List pending requests and paired devices');
    console.log('');
    console.log('  service <install|start|stop|status|uninstall>');
    console.log('    Manage the per-user Windows Scheduled Task');
    console.log('');
    console.log('  doctor');
    console.log('    Print identity, Gate home, listener, and probe status');
    console.log('');
    console.log('Environment variables:');
    console.log('  GATE_NAME  - Name of the Gate (defaults to "Versutus Gate")');
    console.log('');
    process.exit(0);
  }

  if (command === 'add') {
    await handleAdd(args);
  } else if (command === 'add-environment') {
    await handleAddEnvironment(args);
  } else if (command === 'add-kind') {
    await handleAddKind(args);
  } else if (command === 'start') {
    await handleStart();
  } else if (command === 'pair') {
    await handlePair(args);
  } else if (command === 'service') {
    await handleService(args);
  } else if (command === 'doctor') {
    await handleDoctor();
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
