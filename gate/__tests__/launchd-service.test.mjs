import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LAUNCHD_LABEL,
  buildLaunchAgent,
  defaultLaunchdPath,
  describeLaunchdState,
  escapePlistString,
  launchAgentPath,
  parseLaunchctlPrint,
  runLaunchdService,
  serviceBackendFor,
  unsupportedServiceMessage,
} from '../core/service/launchd-agent.mjs';
import { buildTaskDefinition } from '../core/service/windows-task.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = join(__dirname, '..', 'cli.mjs');
const UID = 501;
const TARGET = `gui/${UID}/${LAUNCHD_LABEL}`;

const PRINT_RUNNING = `gui/501/com.versutus.gate = {
\tactive count = 1
\tpath = /Users/test/Library/LaunchAgents/com.versutus.gate.plist
\ttype = LaunchAgent
\tstate = running

\tprogram = /usr/local/bin/node
\targuments = {
\t\t/usr/local/bin/node
\t\t/code/Versutus/gate/cli.mjs
\t\tstart
\t}

\tenvironment = {
\t\tPATH => /usr/local/bin:/usr/bin:/bin
\t\tVERSUTUS_GATE_HOST => 0.0.0.0
\t\tVERSUTUS_GATE_PORT => 8790
\t}

\tdomain = gui/501 [100005]
\truns = 3
\tpid = 4242
\timmediate reason = speculative
\tforks = 0
\texecs = 1
\tlast exit code = 0

\tendpoints = {
\t\tstate = active
\t}
}
`;

const PRINT_WAITING = `gui/501/com.versutus.gate = {
\tpath = /Users/test/Library/LaunchAgents/com.versutus.gate.plist
\tstate = not running
\tlast exit code = 75
}
`;

/**
 * A scripted launchctl/plutil: `script(command, args, callIndex)` returns a
 * partial result; every call is recorded. Nothing touches the real launchd.
 */
function fakeRun(script = () => ({})) {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    const result = script(command, args, calls.length - 1) ?? {};
    return { status: 0, stdout: '', stderr: '', error: null, ...result };
  };
  return { run, calls };
}

/** launchctl that reports `loaded` for print until it is booted out / bootstrapped. */
function statefulLaunchctl({ loaded = false, bootstrapFailures = 0, bootoutResult, bootstrapResult, plutil } = {}) {
  let isLoaded = loaded;
  let failuresLeft = bootstrapFailures;
  return fakeRun((command, args) => {
    if (command === 'plutil') return plutil ?? { status: 0, stdout: 'OK' };
    const [verb] = args;
    if (verb === 'print') return isLoaded ? { status: 0, stdout: PRINT_RUNNING } : { status: 113, stderr: 'Could not find service' };
    if (verb === 'bootout') {
      if (bootoutResult) return bootoutResult;
      if (!isLoaded) return { status: 3, stderr: 'Boot-out failed: 3: No such process' };
      isLoaded = false;
      return {};
    }
    if (verb === 'bootstrap') {
      if (bootstrapResult) return bootstrapResult;
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        return { status: 5, stderr: 'Bootstrap failed: 5: Input/output error' };
      }
      isLoaded = true;
      return {};
    }
    return {};
  });
}

async function withTemp(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'gate-launchd-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function deps(dir, overrides = {}) {
  const lines = [];
  const errors = [];
  const sleeps = [];
  return {
    lines,
    errors,
    sleeps,
    opts: {
      env: { HOME: join(dir, 'home'), VERSUTUS_GATE_HOME: join(dir, 'gate-home') },
      uid: UID,
      nodeExe: '/usr/local/bin/node',
      codeRoot: '/code/Versutus',
      agentsDir: join(dir, 'LaunchAgents'),
      out: (line) => lines.push(line),
      err: (line) => errors.push(line),
      sleep: async (ms) => { sleeps.push(ms); },
      ...overrides,
    },
  };
}

// ---------------------------------------------------------------- plist

test('LaunchAgent plist runs gate start from the code root under launchd supervision', () => {
  const agent = buildLaunchAgent({ nodeExe: '/opt/node/bin/node', codeRoot: '/code/Versutus', home: '/Users/ethan' });
  assert.equal(agent.label, 'com.versutus.gate');
  assert.deepEqual(agent.programArguments, ['/opt/node/bin/node', '/code/Versutus/gate/cli.mjs', 'start']);
  const xml = agent.plist;
  assert.match(xml, /<!DOCTYPE plist PUBLIC "-\/\/Apple\/\/DTD PLIST 1\.0\/\/EN"/);
  assert.match(xml, /<key>Label<\/key>\s*<string>com\.versutus\.gate<\/string>/);
  assert.match(xml, /<key>ProgramArguments<\/key>\s*<array>\s*<string>\/opt\/node\/bin\/node<\/string>\s*<string>\/code\/Versutus\/gate\/cli\.mjs<\/string>\s*<string>start<\/string>\s*<\/array>/);
  assert.match(xml, /<key>WorkingDirectory<\/key>\s*<string>\/code\/Versutus<\/string>/);
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(xml, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.match(xml, /<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
  assert.match(xml, /<key>StandardOutPath<\/key>\s*<string>\/Users\/ethan\/\.local\/share\/Versutus\/Gate\/logs\/gate\.out\.log<\/string>/);
  assert.match(xml, /<key>StandardErrorPath<\/key>\s*<string>\/Users\/ethan\/\.local\/share\/Versutus\/Gate\/logs\/gate\.err\.log<\/string>/);
  assert.match(xml, /<key>HOME<\/key>\s*<string>\/Users\/ethan<\/string>/);
  // No bind/port/home override unless asked for: the Gate's defaults apply.
  assert.doesNotMatch(xml, /VERSUTUS_GATE_HOST|VERSUTUS_GATE_PORT|VERSUTUS_GATE_HOME/);
  // Never the Windows supervisor.
  assert.doesNotMatch(xml, /service run|conhost/);
});

test('launchd PATH leads with the node directory and includes ~/.local/bin and Homebrew', () => {
  const path = defaultLaunchdPath({ nodeExe: '/Users/ethan/.local/bin/node', home: '/Users/ethan' });
  const entries = path.split(':');
  assert.equal(entries[0], '/Users/ethan/.local/bin');
  assert.equal(entries.filter((entry) => entry === '/Users/ethan/.local/bin').length, 1, 'deduplicated');
  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']) assert.ok(entries.includes(dir), dir);
  const agent = buildLaunchAgent({ nodeExe: '/n/bin/node', codeRoot: '/c', home: '/h' });
  assert.equal(agent.environment.PATH.split(':')[0], '/n/bin');
});

test('host, port and gate home pass through as VERSUTUS_GATE_* environment', () => {
  const agent = buildLaunchAgent({ nodeExe: '/n', codeRoot: '/c', home: '/h', host: '0.0.0.0', port: 8790, gateHome: '/data/gate' });
  assert.equal(agent.environment.VERSUTUS_GATE_HOST, '0.0.0.0');
  assert.equal(agent.environment.VERSUTUS_GATE_PORT, '8790');
  assert.equal(agent.environment.VERSUTUS_GATE_HOME, '/data/gate');
  assert.match(agent.plist, /<key>VERSUTUS_GATE_HOST<\/key>\s*<string>0\.0\.0\.0<\/string>/);
  assert.match(agent.plist, /<key>VERSUTUS_GATE_PORT<\/key>\s*<string>8790<\/string>/);
  assert.equal(agent.stdoutPath, '/data/gate/logs/gate.out.log');
});

test('plist values are XML-escaped', () => {
  const agent = buildLaunchAgent({ nodeExe: '/n/no<de>', codeRoot: `/Users/e/R&D "it's"`, home: '/Users/e' });
  assert.doesNotMatch(agent.plist, /R&D/);
  assert.doesNotMatch(agent.plist, /no<de>/);
  assert.match(agent.plist, /<string>\/Users\/e\/R&amp;D &quot;it&apos;s&quot;<\/string>/);
  assert.match(agent.plist, /<string>\/n\/no&lt;de&gt;<\/string>/);
  assert.equal(escapePlistString(`a&b<c>"d'`), 'a&amp;b&lt;c&gt;&quot;d&apos;');
});

test('plist refuses values XML cannot hold and relative or missing paths', () => {
  assert.throws(() => escapePlistString('bad\u0001value'), /control character/);
  assert.throws(() => buildLaunchAgent({ nodeExe: '/n', codeRoot: '/c\u0000', home: '/h' }), /control character/);
  assert.throws(() => buildLaunchAgent({ nodeExe: 'node', codeRoot: '/c', home: '/h' }), /nodeExe/);
  assert.throws(() => buildLaunchAgent({ nodeExe: '/n', codeRoot: 'relative', home: '/h' }), /codeRoot/);
  assert.throws(() => buildLaunchAgent({ nodeExe: '/n', codeRoot: '/c' }), /home/);
  assert.throws(() => buildLaunchAgent({ nodeExe: '/n', codeRoot: '/c', home: '/h', label: 'bad label' }), /label/);
});

test('generated plist is valid for plutil and round-trips escaped values (macOS)', async () => {
  if (process.platform !== 'darwin') return; // plutil exists only on macOS
  await withTemp(async (dir) => {
    const agent = buildLaunchAgent({ nodeExe: '/n/bin/node', codeRoot: `/Users/e/R&D <x> "q" 'a'`, home: '/Users/e', host: '0.0.0.0' });
    const file = join(dir, 'agent.plist');
    writeFileSync(file, agent.plist);
    const lint = spawnSync('plutil', ['-lint', file], { encoding: 'utf8' });
    assert.equal(lint.status, 0, lint.stdout + lint.stderr);
    const json = spawnSync('plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' });
    assert.equal(json.status, 0, json.stderr);
    const parsed = JSON.parse(json.stdout);
    assert.equal(parsed.WorkingDirectory, `/Users/e/R&D <x> "q" 'a'`);
    assert.equal(parsed.EnvironmentVariables.VERSUTUS_GATE_HOST, '0.0.0.0');
    assert.equal(parsed.RunAtLoad, true);
    assert.deepEqual(parsed.KeepAlive, { SuccessfulExit: false });
    assert.equal(parsed.ProgramArguments[2], 'start');
  });
});

test('LaunchAgent path is ~/Library/LaunchAgents/<label>.plist', () => {
  assert.equal(launchAgentPath({ home: '/Users/ethan' }), '/Users/ethan/Library/LaunchAgents/com.versutus.gate.plist');
  assert.equal(launchAgentPath({ agentsDir: '/tmp/x' }), '/tmp/x/com.versutus.gate.plist');
});

// ---------------------------------------------------------------- launchctl print

test('launchctl print is parsed to state, pid, exit code and passed-through env', () => {
  const info = parseLaunchctlPrint(PRINT_RUNNING);
  assert.equal(info.state, 'running', 'the job state, not the nested endpoint state');
  assert.equal(info.pid, 4242);
  assert.equal(info.lastExitCode, '0');
  assert.equal(info.host, '0.0.0.0');
  assert.equal(info.port, '8790');
  assert.equal(describeLaunchdState(info), 'running (pid 4242)');
  const waiting = parseLaunchctlPrint(PRINT_WAITING);
  assert.equal(waiting.pid, null);
  assert.equal(describeLaunchdState(waiting), 'loaded but not running (not running; last exit code 75)');
  assert.match(describeLaunchdState({ state: 'spawn scheduled' }), /restarting/);
  assert.deepEqual(parseLaunchctlPrint(''), { state: null, pid: null, lastExitCode: null, path: null, host: null, port: null });
});

// ---------------------------------------------------------------- install

test('install --dry-run prints the plist and launchctl commands and changes nothing', async () => {
  await withTemp(async (dir) => {
    const { run, calls } = fakeRun();
    const d = deps(dir, { run });
    const code = await runLaunchdService('install', ['--dry-run', '--host', '0.0.0.0'], d.opts);
    assert.equal(code, 0, d.errors.join('\n'));
    assert.deepEqual(calls, [], 'dry run must not run launchctl or plutil');
    assert.equal(existsSync(join(dir, 'LaunchAgents')), false, 'dry run must not write the plist');
    assert.equal(existsSync(join(dir, 'gate-home')), false, 'dry run must not create the log dir');
    const output = d.lines.join('\n');
    assert.match(output, /Dry run/);
    assert.match(output, /<key>VERSUTUS_GATE_HOST<\/key>\s*<string>0\.0\.0\.0<\/string>/);
    assert.ok(output.includes(`launchctl bootstrap gui/${UID} ${join(dir, 'LaunchAgents', 'com.versutus.gate.plist')}`));
    assert.ok(output.includes(`launchctl bootout ${TARGET}`));
  });
});

test('install writes the plist, lints it and bootstraps it into gui/<uid>', async () => {
  await withTemp(async (dir) => {
    const { run, calls } = statefulLaunchctl();
    const d = deps(dir, { run });
    const code = await runLaunchdService('install', [], d.opts);
    assert.equal(code, 0, d.errors.join('\n'));
    const plistPath = join(dir, 'LaunchAgents', 'com.versutus.gate.plist');
    const written = readFileSync(plistPath, 'utf8');
    assert.match(written, /<string>\/code\/Versutus\/gate\/cli\.mjs<\/string>/);
    assert.match(written, /<key>VERSUTUS_GATE_HOME<\/key>/);
    assert.ok(existsSync(join(dir, 'gate-home', 'logs')), 'log dir exists before launchd opens the log paths');
    assert.deepEqual(calls, [
      ['plutil', '-lint', plistPath],
      ['launchctl', 'print', TARGET],
      ['launchctl', 'bootstrap', `gui/${UID}`, plistPath],
      ['launchctl', 'print', TARGET],
    ]);
    assert.match(d.lines.join('\n'), /service installed: com\.versutus\.gate loaded/);
    assert.match(d.lines.join('\n'), /bind address: 127\.0\.0\.1 \(default/);
  });
});

test('install passes --host through, and VERSUTUS_GATE_HOST when no flag is given', async () => {
  await withTemp(async (dir) => {
    const plistPath = join(dir, 'LaunchAgents', 'com.versutus.gate.plist');
    const first = deps(dir, { run: statefulLaunchctl().run });
    assert.equal(await runLaunchdService('install', ['--host', '100.64.1.2', '--port', '8790'], first.opts), 0, first.errors.join('\n'));
    let xml = readFileSync(plistPath, 'utf8');
    assert.match(xml, /<key>VERSUTUS_GATE_HOST<\/key>\s*<string>100\.64\.1\.2<\/string>/);
    assert.match(xml, /<key>VERSUTUS_GATE_PORT<\/key>\s*<string>8790<\/string>/);

    const second = deps(dir, { run: statefulLaunchctl().run });
    second.opts.env = { ...second.opts.env, VERSUTUS_GATE_HOST: '0.0.0.0' };
    assert.equal(await runLaunchdService('install', [], second.opts), 0, second.errors.join('\n'));
    xml = readFileSync(plistPath, 'utf8');
    assert.match(xml, /<key>VERSUTUS_GATE_HOST<\/key>\s*<string>0\.0\.0\.0<\/string>/);
    assert.doesNotMatch(xml, /VERSUTUS_GATE_PORT/);

    const third = deps(dir, { run: statefulLaunchctl().run });
    third.opts.env = { ...third.opts.env, VERSUTUS_GATE_HOST: '0.0.0.0' };
    assert.equal(await runLaunchdService('install', ['--host', '127.0.0.1'], third.opts), 0);
    assert.match(readFileSync(plistPath, 'utf8'), /<key>VERSUTUS_GATE_HOST<\/key>\s*<string>127\.0\.0\.1<\/string>/, 'the flag wins');
  });
});

test('install refuses a bad --host, --port or --node before touching anything', async () => {
  await withTemp(async (dir) => {
    for (const args of [['--host', 'my-mac.local'], ['--host'], ['--port', '99999'], ['--node', 'node'], ['--node', join(dir, 'missing-node')]]) {
      const { run, calls } = fakeRun();
      const d = deps(dir, { run });
      const code = await runLaunchdService('install', args, d.opts);
      assert.equal(code, 1, args.join(' '));
      assert.match(d.errors.join('\n'), /^Error: /, args.join(' '));
      assert.deepEqual(calls, [], args.join(' '));
      assert.equal(existsSync(join(dir, 'LaunchAgents')), false, args.join(' '));
    }
  });
});

test('install --node puts that node in ProgramArguments and PATH', async () => {
  await withTemp(async (dir) => {
    const node = join(dir, 'bin', 'node');
    mkdirSync(dirname(node), { recursive: true });
    writeFileSync(node, '');
    const d = deps(dir, { run: statefulLaunchctl().run });
    assert.equal(await runLaunchdService('install', ['--node', node], d.opts), 0, d.errors.join('\n'));
    const xml = readFileSync(join(dir, 'LaunchAgents', 'com.versutus.gate.plist'), 'utf8');
    assert.ok(xml.includes(`<array>\n\t\t<string>${node}</string>`));
    assert.ok(xml.includes(`<string>${join(dir, 'bin')}:`));
  });
});

test('install over an already-loaded agent backs up the old plist, boots it out and reloads', async () => {
  await withTemp(async (dir) => {
    const plistPath = join(dir, 'LaunchAgents', 'com.versutus.gate.plist');
    mkdirSync(dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, '<plist>hand-written</plist>');
    const { run, calls } = statefulLaunchctl({ loaded: true });
    const d = deps(dir, { run });
    const code = await runLaunchdService('install', [], d.opts);
    assert.equal(code, 0, d.errors.join('\n'));
    assert.deepEqual(calls.slice(1).map((call) => call[1]), ['print', 'bootout', 'bootstrap', 'print']);
    assert.equal(readFileSync(join(dir, 'gate-home', 'service', 'com.versutus.gate.plist.previous'), 'utf8'), '<plist>hand-written</plist>');
    assert.match(readFileSync(plistPath, 'utf8'), /<key>Label<\/key>/);
    assert.match(d.lines.join('\n'), /already loaded; reloading/);
    assert.match(d.lines.join('\n'), /reloaded from/);
  });
});

test('install retries a bootstrap that races the bootout teardown', async () => {
  await withTemp(async (dir) => {
    const { run, calls } = statefulLaunchctl({ loaded: true, bootstrapFailures: 2 });
    const d = deps(dir, { run });
    assert.equal(await runLaunchdService('install', [], d.opts), 0, d.errors.join('\n'));
    assert.equal(calls.filter((call) => call[1] === 'bootstrap').length, 3);
    assert.deepEqual(d.sleeps, [1000, 1000]);
  });
});

test('install fails loudly, nonzero, when launchd will not load the agent', async () => {
  await withTemp(async (dir) => {
    const { run, calls } = statefulLaunchctl({ bootstrapResult: { status: 5, stderr: 'Bootstrap failed: 5: Input/output error' } });
    const d = deps(dir, { run });
    assert.equal(await runLaunchdService('install', [], d.opts), 1);
    assert.equal(calls.filter((call) => call[1] === 'bootstrap').length, 5);
    assert.match(d.errors.join('\n'), /launchd refused to load com\.versutus\.gate .*Input\/output error/);
  });
});

test('install fails when the loaded agent cannot be booted out', async () => {
  await withTemp(async (dir) => {
    const { run, calls } = statefulLaunchctl({ loaded: true, bootoutResult: { status: 1, stderr: 'Boot-out failed: 1: Operation not permitted' } });
    const d = deps(dir, { run });
    assert.equal(await runLaunchdService('install', [], d.opts), 1);
    assert.equal(calls.some((call) => call[1] === 'bootstrap'), false);
    assert.match(d.errors.join('\n'), /Could not unload the running com\.versutus\.gate.*Operation not permitted/);
  });
});

test('install refuses to load a plist plutil rejects', async () => {
  await withTemp(async (dir) => {
    const { run, calls } = statefulLaunchctl({ plutil: { status: 1, stdout: 'agent.plist: Unexpected character' } });
    const d = deps(dir, { run });
    assert.equal(await runLaunchdService('install', [], d.opts), 1);
    assert.deepEqual(calls.map((call) => call[0]), ['plutil']);
    assert.match(d.errors.join('\n'), /not a valid plist .*Unexpected character.*Nothing was loaded/);
  });
});

test('install fails when bootstrap says yes but the job is not there', async () => {
  await withTemp(async (dir) => {
    const { run } = fakeRun((command, args) => (args[0] === 'print' ? { status: 113 } : {}));
    const d = deps(dir, { run });
    assert.equal(await runLaunchdService('install', [], d.opts), 1);
    assert.match(d.errors.join('\n'), /reported success but gui\/501\/com\.versutus\.gate is not loaded/);
  });
});

// ---------------------------------------------------------------- uninstall

test('uninstall boots the agent out and deletes its plist', async () => {
  await withTemp(async (dir) => {
    const plistPath = join(dir, 'LaunchAgents', 'com.versutus.gate.plist');
    mkdirSync(dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, '<plist/>');
    const { run, calls } = statefulLaunchctl({ loaded: true });
    const d = deps(dir, { run });
    assert.equal(await runLaunchdService('uninstall', [], d.opts), 0, d.errors.join('\n'));
    assert.deepEqual(calls, [['launchctl', 'print', TARGET], ['launchctl', 'bootout', TARGET]]);
    assert.equal(existsSync(plistPath), false);
    assert.match(d.lines.join('\n'), /service uninstalled/);
  });
});

test('uninstall of nothing is a clean no-op', async () => {
  await withTemp(async (dir) => {
    const { run, calls } = statefulLaunchctl();
    const d = deps(dir, { run });
    assert.equal(await runLaunchdService('uninstall', [], d.opts), 0);
    assert.deepEqual(calls.map((call) => call[1]), ['print']);
    assert.match(d.lines.join('\n'), /was not installed/);
  });
});

test('uninstall keeps the plist and exits nonzero when bootout fails', async () => {
  await withTemp(async (dir) => {
    const plistPath = join(dir, 'LaunchAgents', 'com.versutus.gate.plist');
    mkdirSync(dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, '<plist/>');
    const { run } = statefulLaunchctl({ loaded: true, bootoutResult: { status: 1, stderr: 'Operation not permitted' } });
    const d = deps(dir, { run });
    assert.equal(await runLaunchdService('uninstall', [], d.opts), 1);
    assert.equal(existsSync(plistPath), true);
    assert.match(d.errors.join('\n'), /Could not unload com\.versutus\.gate.*Nothing was deleted/);
  });
});

test('uninstall --dry-run runs and deletes nothing', async () => {
  await withTemp(async (dir) => {
    const plistPath = join(dir, 'LaunchAgents', 'com.versutus.gate.plist');
    mkdirSync(dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, '<plist/>');
    const { run, calls } = fakeRun();
    const d = deps(dir, { run });
    assert.equal(await runLaunchdService('uninstall', ['--dry-run'], d.opts), 0);
    assert.deepEqual(calls, []);
    assert.equal(existsSync(plistPath), true);
    assert.ok(d.lines.join('\n').includes(`launchctl bootout ${TARGET}`));
  });
});

// ---------------------------------------------------------------- status

test('status reports running and probes the passed-through host and port', async () => {
  await withTemp(async (dir) => {
    const probed = [];
    const { run } = statefulLaunchctl({ loaded: true });
    const d = deps(dir, { run, probe: async (url) => { probed.push(url); return { reachable: true, detail: 'HTTP 200' }; } });
    // 0.0.0.0 is not an address to connect to: the probe uses loopback.
    assert.equal(await runLaunchdService('status', [], d.opts), 0, d.errors.join('\n'));
    assert.deepEqual(probed, ['http://127.0.0.1:8790/.well-known/gateway.json']);
    const output = d.lines.join('\n');
    assert.match(output, /com\.versutus\.gate: running \(pid 4242\)/);
    assert.match(output, /bind address: 0\.0\.0\.0/);
    assert.match(output, /manifest: reachable \(HTTP 200\)/);
  });
});

test('status probes a specific bound address rather than loopback', async () => {
  await withTemp(async (dir) => {
    const probed = [];
    const print = PRINT_RUNNING.replace('VERSUTUS_GATE_HOST => 0.0.0.0', 'VERSUTUS_GATE_HOST => 100.64.1.2');
    const { run } = fakeRun(() => ({ stdout: print }));
    const d = deps(dir, { run, probe: async (url) => { probed.push(url); return { reachable: true, detail: 'ok' }; } });
    assert.equal(await runLaunchdService('status', [], d.opts), 0);
    assert.deepEqual(probed, ['http://100.64.1.2:8790/.well-known/gateway.json']);
  });
});

test('status exits 1 when the Gate is loaded but not answering or not running', async () => {
  await withTemp(async (dir) => {
    const unreachable = deps(dir, { run: statefulLaunchctl({ loaded: true }).run, probe: async () => ({ reachable: false, detail: 'ECONNREFUSED' }) });
    assert.equal(await runLaunchdService('status', [], unreachable.opts), 1);
    assert.match(unreachable.lines.join('\n'), /manifest: UNREACHABLE \(ECONNREFUSED\)/);

    const waiting = deps(dir, { run: fakeRun(() => ({ stdout: PRINT_WAITING })).run, probe: async () => ({ reachable: true, detail: 'ok' }) });
    assert.equal(await runLaunchdService('status', [], waiting.opts), 1);
    assert.match(waiting.lines.join('\n'), /loaded but not running \(not running; last exit code 75\)/);
  });
});

test('status says plainly when the agent is not installed, or installed but not loaded', async () => {
  await withTemp(async (dir) => {
    const missing = deps(dir, { run: statefulLaunchctl().run, probe: async () => ({ reachable: true }) });
    assert.equal(await runLaunchdService('status', [], missing.opts), 1);
    assert.match(missing.lines.join('\n'), /not installed\. Run `node gate\/cli\.mjs service install`/);

    const plistPath = join(dir, 'LaunchAgents', 'com.versutus.gate.plist');
    mkdirSync(dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, '<plist/>');
    const unloaded = deps(dir, { run: statefulLaunchctl().run, probe: async () => ({ reachable: true }) });
    assert.equal(await runLaunchdService('status', [], unloaded.opts), 1);
    assert.match(unloaded.lines.join('\n'), /installed at .* but not loaded/);
  });
});

// ---------------------------------------------------------------- start / stop / restart / run

test('start bootstraps an installed agent, kicks a loaded one, and refuses when not installed', async () => {
  await withTemp(async (dir) => {
    const none = deps(dir, { run: statefulLaunchctl().run });
    assert.equal(await runLaunchdService('start', [], none.opts), 1);
    assert.match(none.errors.join('\n'), /not installed .*service install/);

    const plistPath = join(dir, 'LaunchAgents', 'com.versutus.gate.plist');
    mkdirSync(dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, '<plist/>');
    const unloaded = statefulLaunchctl();
    const a = deps(dir, { run: unloaded.run });
    assert.equal(await runLaunchdService('start', [], a.opts), 0);
    assert.deepEqual(unloaded.calls.map((call) => call[1]), ['print', 'bootstrap']);

    const loaded = statefulLaunchctl({ loaded: true });
    const b = deps(dir, { run: loaded.run });
    assert.equal(await runLaunchdService('start', [], b.opts), 0);
    assert.deepEqual(loaded.calls.at(-1), ['launchctl', 'kickstart', TARGET]);
  });
});

test('stop boots the agent out but keeps the plist; restart kickstarts -k', async () => {
  await withTemp(async (dir) => {
    const stop = statefulLaunchctl({ loaded: true });
    const a = deps(dir, { run: stop.run });
    assert.equal(await runLaunchdService('stop', [], a.opts), 0);
    assert.deepEqual(stop.calls, [['launchctl', 'bootout', TARGET]]);
    assert.match(a.lines.join('\n'), /service stopped/);

    const again = deps(dir, { run: statefulLaunchctl().run });
    assert.equal(await runLaunchdService('stop', [], again.opts), 0);
    assert.match(again.lines.join('\n'), /was not running/);

    const restart = fakeRun();
    const b = deps(dir, { run: restart.run });
    assert.equal(await runLaunchdService('restart', [], b.opts), 0);
    assert.deepEqual(restart.calls, [['launchctl', 'kickstart', '-k', TARGET]]);

    const notLoaded = deps(dir, { run: fakeRun(() => ({ status: 3, stderr: 'No such process' })).run });
    assert.equal(await runLaunchdService('restart', [], notLoaded.opts), 1);
    assert.match(notLoaded.errors.join('\n'), /not loaded/);
  });
});

test('run and unknown subcommands exit 1 with guidance; missing HOME or uid fails plainly', async () => {
  await withTemp(async (dir) => {
    const run = deps(dir, { run: fakeRun().run });
    assert.equal(await runLaunchdService('run', [], run.opts), 1);
    assert.match(run.errors.join('\n'), /launchd supervises the Gate itself/);

    const unknown = deps(dir, { run: fakeRun().run });
    assert.equal(await runLaunchdService('bogus', [], unknown.opts), 1);
    assert.match(unknown.errors.join('\n'), /^Usage: node gate\/cli\.mjs service </);

    const noHome = deps(dir, { run: fakeRun().run, env: {} });
    assert.equal(await runLaunchdService('install', [], noHome.opts), 1);
    assert.match(noHome.errors.join('\n'), /HOME is not set/);

    const noUid = deps(dir, { run: fakeRun().run, uid: null });
    assert.equal(await runLaunchdService('status', [], noUid.opts), 1);
    assert.match(noUid.errors.join('\n'), /user id/);
  });
});

// ---------------------------------------------------------------- platform routing

test('Windows keeps the Scheduled Task backend; macOS gets launchd; others are told plainly', () => {
  assert.equal(serviceBackendFor('win32'), 'windows-task');
  assert.equal(serviceBackendFor('darwin'), 'launchd');
  assert.equal(serviceBackendFor('linux'), 'unsupported');
  assert.match(unsupportedServiceMessage('linux'), /not supported on linux yet/);
  // The Windows task still runs the hidden `service run` supervisor.
  const task = buildTaskDefinition({ user: 'ETHANSPC\\ethan' });
  assert.match(task.xml, /--headless .*service run/);
});

test('CLI: `service install --dry-run` prints a plist on macOS and a clear refusal elsewhere', async () => {
  await withTemp(async (dir) => {
    const home = join(dir, 'home');
    const { code, stdout, stderr } = await new Promise((resolve) => {
      const proc = spawn(process.execPath, [cliPath, 'service', 'install', '--dry-run', '--host', '0.0.0.0'], {
        cwd: dir,
        env: { ...process.env, HOME: home, VERSUTUS_GATE_HOME: join(dir, 'gate-home') },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      proc.stdout.on('data', (chunk) => { out += chunk; });
      proc.stderr.on('data', (chunk) => { err += chunk; });
      proc.on('close', (exitCode) => resolve({ code: exitCode, stdout: out, stderr: err }));
    });
    if (process.platform === 'darwin') {
      assert.equal(code, 0, stderr);
      assert.ok(stdout.includes(join(home, 'Library', 'LaunchAgents', 'com.versutus.gate.plist')));
      assert.match(stdout, /<key>VERSUTUS_GATE_HOST<\/key>\s*<string>0\.0\.0\.0<\/string>/);
      assert.equal(existsSync(join(home, 'Library')), false, 'dry run wrote nothing');
    } else if (process.platform !== 'win32') {
      assert.equal(code, 1);
      assert.match(stderr, /not supported on/);
    }
  });
});
