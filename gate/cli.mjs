#!/usr/bin/env node

import { mkdir, writeFile, access } from 'node:fs/promises';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createGate } from './core/server.mjs';
import { PairingStore } from './core/pairing.mjs';
import { DeviceTokenStore } from './core/device-tokens.mjs';
import { validateId, buildInstanceConfigTemplate, getKindTemplate, describeStartFailure, resolveStartPort, startFailureExitCode } from './core/cli-helpers.mjs';
import { resolveGateHome } from './core/paths.mjs';
import { ProviderStore } from './core/providers/store.mjs';
import { migrateLegacyProviders } from './core/providers/migrate-v1.mjs';
import { CliEnvironmentStore } from './core/cli-environments/store.mjs';
import { CliAdapterRegistry } from './core/cli-environments/adapter-registry.mjs';
import { TASK_NAME, buildTaskDefinition, writeTaskFile } from './core/service/windows-task.mjs';
import { acquireInstanceLock } from './core/service/instance-lock.mjs';
import { RotatingLog } from './core/service/rotating-log.mjs';
import { Supervisor } from './core/service/supervisor.mjs';
import { doctor } from './core/service/doctor.mjs';
import { diagnoseBotGroupStore, diagnoseEnvironmentRecords, probeLocalGate } from './core/service/diagnostics.mjs';
import { CredentialVault } from './core/credentials/vault.mjs';
import { installVoice, uvRunner, voiceDoctor, voicePaths, voiceStatus } from './core/voice/runtime.mjs';

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
 * Handle 'remove-environment' command: delete a CLI environment record from
 * Gate home — the headless counterpart of the phone's Remove, and the recovery
 * path when a record is too corrupt for the app or doctor to read at all.
 */
async function handleRemoveEnvironment(args) {
  const id = args[0];

  if (!id) {
    console.error('Error: environment id is required');
    console.error('Usage: node gate/cli.mjs remove-environment <id>');
    process.exit(1);
  }

  if (!validateId(id)) {
    console.error(`Error: environment id must be lowercase alphanumeric with hyphens, got "${id}"`);
    process.exit(1);
  }

  const gateHome = resolveGateHome();
  const store = new CliEnvironmentStore(gateHome);
  const file = join(store.dir, `${id}.json`);

  // Presence by filename, not by parse: a corrupt record — the incident this
  // command exists for — makes store.get() return null exactly like an absent
  // one, and that record is precisely the one that must stay removable.
  try {
    await access(file);
  } catch {
    console.error(`Error: no environment "${id}" found in ${store.dir}`);
    console.error('Run "node gate/cli.mjs doctor" to see what is registered.');
    process.exit(1);
  }

  await store.delete(id);

  console.log(`Removed CLI environment "${id}" (${file})`);
  // Records are read from disk on every request, so a running Gate stops
  // listing the environment immediately. What a disk delete cannot reach: a
  // task already in flight keeps its process tree until it finishes or is
  // cancelled from Recent runs.
  console.log('The change takes effect immediately — no Gate restart needed.');
  console.log('If a task was still running on it, cancel it from Recent runs.');
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
async function handleStart(args = []) {
  const gateName = process.env.GATE_NAME || 'Versutus Gate';

  // Web demo target: let named browser origins call this Gate cross-origin
  // (the app in a phone browser sits on Metro's port, not this one). Off by
  // default — see docs/commercial/pilot-runbook-v1.md §0.
  const flagIndex = args.indexOf('--allow-origin');
  if (flagIndex !== -1) {
    const origins = String(args[flagIndex + 1] ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (origins.length === 0 || origins.some((entry) => !/^https?:\/\//i.test(entry))) {
      console.error('Error: --allow-origin expects http(s)://host:port origins, comma-separated');
      process.exit(1);
    }
    process.env.VERSUTUS_GATE_ALLOW_ORIGIN = origins.join(',');
    console.log(`Web CORS: browser calls allowed from ${origins.join(', ')}`);
  }

  // Named port: a demo/sandbox Gate can run beside the production one instead
  // of fighting over 8760. Flag wins over VERSUTUS_GATE_PORT, default 8760.
  const portResolution = resolveStartPort(args);
  if (portResolution.error) {
    console.error(`Error: ${portResolution.error}`);
    process.exit(1);
  }
  const port = portResolution.port;

  console.log(`Starting ${gateName}...`);
  const gateHome = resolveGateHome();
  let lock;
  try {
    lock = await acquireInstanceLock(gateHome);
  } catch (err) {
    console.error(describeStartFailure(err, port));
    process.exit(startFailureExitCode(err));
  }
  // 'exit' handlers must finish synchronously: an async release here dies with
  // the process mid-unlink and leaks gate.lock naming a dead pid (reproduced
  // 2026-08-22 — every failed start left debris behind).
  process.on('exit', () => { lock.releaseSync(); });
  // A supervised child (the Gate service) is spawned with an IPC channel: a
  // {type:'shutdown'} message or a parent disconnect asks for the same
  // graceful close SIGINT gets, capped so a hung close cannot wedge the
  // supervisor's restart.
  let gate = null;
  const supervisedShutdown = () => {
    if (!gate) process.exit(0);
    const force = setTimeout(() => process.exit(0), 15000);
    force.unref?.();
    gate.close().then(
      () => { clearTimeout(force); process.exit(0); },
      () => { clearTimeout(force); process.exit(0); },
    );
  };
  if (process.send) {
    process.on('message', (message) => {
      if (message?.type === 'shutdown') supervisedShutdown();
    });
    process.on('disconnect', supervisedShutdown);
  }
  try {
    await migrateLegacyProviders({ sourceRoot: __dirname, gateHome });
    gate = await createGate({
      root: __dirname,
      port,
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
    // Outside 'exit' the async release completes; releaseSync in the exit
    // handler above is then a no-op thanks to the shared released guard.
    await lock.release().catch(() => {});
    console.error(describeStartFailure(err, port));
    process.exit(startFailureExitCode(err));
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
  if (sub === 'install') return serviceInstall();
  if (sub === 'run') return serviceRun();
  if (sub === 'stop') return serviceStop();
  if (sub === 'start') return serviceStart();
  if (sub === 'restart') return serviceRestart();
  if (sub === 'uninstall') return serviceUninstall();
  if (sub === 'status') return serviceStatus();
  console.error('Usage: node gate/cli.mjs service <install|run|stop|start|restart|status|uninstall>');
  process.exit(1);
}

/**
 * The checkout the supervised Gate runs from. Gate state (tokens, pairing,
 * registry) lives in this folder — running from anywhere else orphans the
 * paired phones.
 */
const SERVICE_CODE_ROOT = 'C:\\Projects\\Versutus';
const GATE_PORT = 8760;
const GATE_MANIFEST = `http://127.0.0.1:${GATE_PORT}/.well-known/gateway.json`;

function serviceUser() {
  return process.env.USERNAME ? `${process.env.USERDOMAIN || 'USER'}\\${process.env.USERNAME}` : process.env.USER;
}

function servicePaths(gateHome = resolveGateHome()) {
  const dir = join(gateHome, 'service');
  return {
    gateHome,
    dir,
    xml: join(dir, 'VersutusGate.xml'),
    state: join(dir, 'supervisor.json'),
    control: join(dir, 'control.json'),
  };
}

function schtasks(taskArgs) {
  return execFileSync('schtasks', taskArgs, { encoding: 'utf8', windowsHide: true });
}

function serviceGitHead(codeRoot) {
  try {
    return execFileSync('git', ['-C', codeRoot, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
  } catch {
    return null;
  }
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function serviceInstall() {
  const paths = servicePaths();
  const definition = buildTaskDefinition({ user: serviceUser(), codeRoot: SERVICE_CODE_ROOT });
  mkdirSync(paths.dir, { recursive: true });
  writeTaskFile(definition.xml, paths.xml);
  schtasks(['/Create', '/TN', TASK_NAME, '/XML', paths.xml, '/F']);
  schtasks(['/Run', '/TN', TASK_NAME]);
  console.log(`service installed from ${SERVICE_CODE_ROOT} at ${serviceGitHead(SERVICE_CODE_ROOT)}`);
}

async function serviceRun() {
  const paths = servicePaths();
  mkdirSync(paths.dir, { recursive: true });
  // One supervisor per machine: a second `service run` (a stale task entry
  // firing twice, a manual launch) must refuse instead of double-spawning.
  const lock = await acquireInstanceLock(paths.dir, { name: 'supervisor.lock' });
  const rlog = new RotatingLog(join(paths.gateHome, 'logs'));
  const say = (message) => rlog.write('supervisor', `${message}\n`);

  const spawnGate = () => {
    const child = spawn(
      process.execPath,
      [join(SERVICE_CODE_ROOT, 'gate', 'cli.mjs'), 'start'],
      { cwd: SERVICE_CODE_ROOT, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true },
    );
    // Separate stream keys: a half line held from stdout must never be glued
    // onto stderr's text, or a `Token:` line escapes redaction.
    child.stdout?.on('data', (chunk) => rlog.write('gate', chunk, 'stdout'));
    child.stderr?.on('data', (chunk) => rlog.write('gate', chunk, 'stderr'));
    return child;
  };
  const probe = async () => (await probeLocalGate(
    GATE_MANIFEST,
    (url) => fetch(url, { signal: AbortSignal.timeout(10000) }),
  )).reachable;
  const killTree = (pid) => {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  };

  let resolveStopped;
  const stopped = new Promise((resolve) => { resolveStopped = resolve; });
  const sup = new Supervisor({
    spawnGate,
    probe,
    killTree,
    writeState: (state) => writeFileSync(paths.state, JSON.stringify(state, null, 2)),
    log: say,
    codeRoot: SERVICE_CODE_ROOT,
    gitHead: serviceGitHead(SERVICE_CODE_ROOT),
  });
  say(`supervisor starting (code root ${SERVICE_CODE_ROOT})`);
  sup.start();

  // `service stop|restart` talks to the supervisor through this file — a
  // named pipe would die with the very crash the supervisor survives.
  const poll = setInterval(() => {
    let action = null;
    try {
      action = JSON.parse(readFileSync(paths.control, 'utf8')).action;
    } catch {
      return;
    }
    rmSync(paths.control, { force: true });
    if (action === 'stop') {
      clearInterval(poll);
      sup.stop().then(() => resolveStopped());
    } else if (action === 'restart') {
      sup.requestRestart();
    }
  }, 2000);

  process.on('SIGINT', () => {
    clearInterval(poll);
    sup.stop().then(() => resolveStopped());
  });
  await stopped;
  rlog.close();
  await lock.release().catch(() => {});
}

async function serviceStop() {
  const paths = servicePaths();
  // Disable FIRST: otherwise the 5-minute time trigger revives the
  // supervisor while we are stopping it.
  schtasks(['/Change', '/TN', TASK_NAME, '/DISABLE']);
  writeFileSync(paths.control, JSON.stringify({ action: 'stop' }));
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      if (JSON.parse(readFileSync(paths.state, 'utf8')).status === 'stopped') break;
    } catch {
      // No state yet — keep waiting for the supervisor to get there.
    }
    await sleepMs(500);
  }
  try {
    schtasks(['/End', '/TN', TASK_NAME]);
  } catch {
    // Already ended is the outcome we wanted anyway.
  }
  // Tree-kill leftovers only when the port proves someone is still holding it
  // — a stale supervisor.json pid may have been recycled by Windows.
  const stillUp = await probeLocalGate(GATE_MANIFEST);
  if (stillUp.reachable) {
    try {
      const state = JSON.parse(readFileSync(paths.state, 'utf8'));
      for (const pid of [state.supervisorPid, state.childPid]) {
        if (!Number.isInteger(pid)) continue;
        try {
          execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        } catch {
          // Dead already — the port check below is the real verdict.
        }
      }
    } catch {
      // No state to name a pid; the port check below still applies.
    }
  }
  const closedBy = Date.now() + 20000;
  while (Date.now() < closedBy) {
    if (!(await probeLocalGate(GATE_MANIFEST)).reachable) break;
    await sleepMs(500);
  }
  console.log('service stopped');
}

async function serviceStart() {
  schtasks(['/Change', '/TN', TASK_NAME, '/ENABLE']);
  schtasks(['/Run', '/TN', TASK_NAME]);
  console.log('service started');
}

async function serviceRestart() {
  const paths = servicePaths();
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.control, JSON.stringify({ action: 'restart' }));
  console.log('restart requested');
}

async function serviceUninstall() {
  await serviceStop();
  try {
    schtasks(['/Delete', '/TN', TASK_NAME, '/F']);
  } catch (error) {
    console.error(`task delete failed: ${error.message}`);
    process.exit(1);
  }
  console.log('service uninstalled');
}

async function serviceStatus() {
  const paths = servicePaths();
  let taskInfo = '';
  try {
    taskInfo = schtasks(['/Query', '/TN', TASK_NAME, '/V', '/FO', 'LIST']);
    console.log(taskInfo.trim());
  } catch (error) {
    console.log(`task query failed: ${error.message}`);
  }
  let state = null;
  try {
    state = JSON.parse(readFileSync(paths.state, 'utf8'));
    console.log(JSON.stringify(state, null, 2));
  } catch {
    console.log('no supervisor state');
  }
  const probe = await probeLocalGate(GATE_MANIFEST);
  console.log(`manifest: ${probe.reachable ? 'reachable' : 'UNREACHABLE'} (${probe.detail})`);
  if (!probe.reachable || state?.status !== 'running') process.exit(1);
}

async function handleDoctor(args = []) {
  const user = process.env.USERNAME ? `${process.env.USERDOMAIN || 'USER'}\\${process.env.USERNAME}` : process.env.USER;
  const gateHome = resolveGateHome();
  const portResolution = resolveStartPort(args);
  if (portResolution.error) {
    console.error(`Error: ${portResolution.error}`);
    process.exit(1);
  }
  const listen = `http://127.0.0.1:${portResolution.port}`;
  const [environmentFindings, storeFindings, serverProbe] = await Promise.all([
    diagnoseEnvironmentRecords(join(gateHome, 'config', 'environments'), {
      vault: new CredentialVault({ gateHome }),
    }),
    diagnoseBotGroupStore(gateHome),
    probeLocalGate(`${listen}/.well-known/gateway.json`),
  ]);
  const findings = [...environmentFindings, ...storeFindings];
  console.log(doctor({
    user,
    gateHome,
    listen,
    serverProbe,
    environmentFindings: findings,
  }));
  // Scriptable verdict: a health check that always exits 0 cannot gate a demo.
  if (findings.some((finding) => finding.severity === 'error')) {
    process.exitCode = 1;
  }
}

/**
 * Install, inspect and report the local PC voice runtime.
 */
async function handleVoice(args = []) {
  const sub = args[0];
  const paths = voicePaths();
  if (sub === 'install') {
    const result = await installVoice({
      paths,
      cpu: args.includes('--cpu'),
      runUv: uvRunner(),
      fetch: globalThis.fetch,
      log: (message) => console.log(`[voice] ${message}`),
    });
    console.log(`[voice] installed ${result.models.length} model(s) into ${paths.models}`);
    return;
  }
  if (sub === 'doctor') {
    const report = voiceDoctor({ paths, log: (message) => console.log(`[voice] ${message}`) });
    for (const check of report.checks) {
      console.log(`${check.ok ? 'ok  ' : 'FAIL'} ${check.name}: ${check.detail}`);
    }
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (sub === 'status') {
    console.log(JSON.stringify(voiceStatus({ paths }), null, 2));
    return;
  }
  console.error('Usage: node gate/cli.mjs voice <install [--cpu]|doctor|status>');
  process.exit(1);
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
    console.log('  remove-environment <id>');
    console.log('    Delete a CLI environment record from Gate home — also the recovery');
    console.log('    path when a record is too corrupt to read; no Gate restart needed');
    console.log('');
    console.log('  start [--allow-origin <origin>[,<origin>...]] [--port <n>]');
    console.log('    Start the Gate HTTP server (default port 8760; --port or');
    console.log('    VERSUTUS_GATE_PORT names another, e.g. a demo Gate beside a');
    console.log('    running production one). A second instance also needs its own');
    console.log('    home: set VERSUTUS_GATE_HOME to a different folder — the');
    console.log('    instance lock is taken per home, so two Gates sharing one');
    console.log('    home cannot run at the same time.');
    console.log('    --allow-origin names browser origins (web demo target) that may');
    console.log('    call this Gate cross-origin; off by default');
    console.log('');
    console.log('  pair <open|approve|revoke|list>');
    console.log('    Manage device pairing and access tokens');
    console.log('    open [--minutes N]  Open the pairing window (default 5 minutes)');
    console.log('    approve <requestId> Approve a pending access request');
    console.log('    revoke <deviceId>   Revoke a device\'s access token');
    console.log('    list                List pending requests and paired devices');
    console.log('');
    console.log('  service <install|run|stop|start|restart|status|uninstall>');
    console.log('    Supervise the Gate as a per-user Windows Scheduled Task');
    console.log('    (hidden, logon + every-5-minute triggers). install registers');
    console.log('    and starts it; run is the supervisor the task launches;');
    console.log('    status exits 1 unless the Gate answers.');
    console.log('');
    console.log('  doctor');
    console.log('    Inspect the Gate machine: local listener and every CLI');
    console.log('    environment record (JSON, schema/corruption, executable on');
    console.log('    disk, credential bindings resolvable in the vault).');
    console.log('    Exit code 1 when a record has a problem.');
    console.log('');
    console.log('  voice <install [--cpu]|doctor|status>');
    console.log('    Install and inspect the local PC voice models (M5). install');
    console.log('    creates the uv venv and downloads the locked models; doctor');
    console.log('    checks the venv, GPU and models load; status prints the');
    console.log('    engine capabilities the phone reads.');
    console.log('');
    console.log('Environment variables:');
    console.log('  GATE_NAME  - Name of the Gate (defaults to "Versutus Gate")');
    console.log('  VERSUTUS_GATE_HOME - Where this Gate keeps its records and state');
    console.log('    (default %LOCALAPPDATA%\\Versutus\\Gate on Windows). Give a');
    console.log('    second/demo Gate its OWN folder here, or the instance lock');
    console.log('    refuses to start beside a running one.');
    console.log('  VERSUTUS_GATE_PORT - Listen port for start/doctor (default 8760;');
    console.log('    a --port flag wins over this)');
    console.log('  VERSUTUS_GATE_ALLOW_ORIGIN - Browser origins allowed to call this');
    console.log('    Gate cross-origin (web demo target), comma-separated');
    console.log('');
    process.exit(0);
  }

  if (command === 'add') {
    await handleAdd(args);
  } else if (command === 'add-environment') {
    await handleAddEnvironment(args);
  } else if (command === 'remove-environment') {
    await handleRemoveEnvironment(args);
  } else if (command === 'add-kind') {
    await handleAddKind(args);
  } else if (command === 'start') {
    await handleStart(args);
  } else if (command === 'pair') {
    await handlePair(args);
  } else if (command === 'service') {
    await handleService(args);
  } else if (command === 'doctor') {
    await handleDoctor(args);
  } else if (command === 'voice') {
    await handleVoice(args);
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
