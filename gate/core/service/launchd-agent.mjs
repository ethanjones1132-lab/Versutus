import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { posix } from 'node:path';

import { resolveStartHost, resolveStartPort } from '../cli-helpers.mjs';
import { resolveGateHome } from '../paths.mjs';

/**
 * macOS counterpart of windows-task.mjs: the Gate as a per-user LaunchAgent.
 *
 * On Windows a hidden `service run` supervisor keeps the Gate alive because
 * Task Scheduler cannot. On macOS launchd IS the supervisor: KeepAlive
 * restarts a crashed `gate/cli.mjs start` (ThrottleInterval spaces the
 * retries), RunAtLoad starts it at login, and StandardOut/ErrorPath keep the
 * logs. So the agent runs `start` directly and `service run` stays Windows-only.
 *
 * The label is the one Ethan's hand-written agent on the Mac already uses
 * (com.versutus.gate, 2026-10), so `service install` replaces that agent
 * in place rather than starting a second Gate that fights it for port 8760
 * and the instance lock.
 */
export const LAUNCHD_LABEL = 'com.versutus.gate';

const SYSTEM_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

// XML 1.0 has no escape for these: a plist holding one is not a plist.
const XML_FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/;

/** Escape a value for a plist <string>/<key>; refuse what XML cannot hold. */
export function escapePlistString(value) {
  const text = String(value);
  if (XML_FORBIDDEN.test(text)) {
    throw new Error(`LaunchAgent value contains a control character XML cannot hold: ${JSON.stringify(text)}`);
  }
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Where a user LaunchAgent for `label` lives. */
export function launchAgentPath({ home, label = LAUNCHD_LABEL, agentsDir } = {}) {
  const dir = agentsDir ?? posix.join(home ?? '', 'Library', 'LaunchAgents');
  return posix.join(dir, `${label}.plist`);
}

/**
 * The PATH launchd hands the Gate. launchd's own default is
 * /usr/bin:/bin:/usr/sbin:/sbin, which finds neither the node running the
 * Gate nor anything under ~/.local/bin or Homebrew that a CLI environment
 * shells out to.
 */
export function defaultLaunchdPath({ nodeExe, home } = {}) {
  const entries = [];
  if (nodeExe) entries.push(posix.dirname(nodeExe));
  if (home) entries.push(posix.join(home, '.local', 'bin'));
  entries.push(...SYSTEM_PATH);
  return [...new Set(entries)].join(':');
}

/**
 * Build the LaunchAgent: label, plist XML, and the pieces the CLI reports.
 * `host`/`port`/`gateHome` are passed through as VERSUTUS_GATE_* only when
 * set, so an agent installed without them follows the Gate's own defaults
 * (127.0.0.1:8760, ~/.local/share/Versutus/Gate).
 */
export function buildLaunchAgent({
  label = LAUNCHD_LABEL,
  nodeExe,
  codeRoot,
  home,
  gateHome,
  host,
  port,
  path,
} = {}) {
  if (!nodeExe || !posix.isAbsolute(nodeExe)) throw new Error('nodeExe must be an absolute path to node');
  if (!codeRoot || !posix.isAbsolute(codeRoot)) throw new Error('codeRoot must be an absolute path to the Versutus checkout');
  if (!home || !posix.isAbsolute(home)) throw new Error('home must be the absolute path of the user\'s home folder');
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(label)) throw new Error(`invalid LaunchAgent label "${label}"`);

  const resolvedGateHome = gateHome || resolveGateHome({ HOME: home }, 'darwin');
  const logDir = posix.join(resolvedGateHome, 'logs');
  const stdoutPath = posix.join(logDir, 'gate.out.log');
  const stderrPath = posix.join(logDir, 'gate.err.log');
  const programArguments = [nodeExe, posix.join(codeRoot, 'gate', 'cli.mjs'), 'start'];
  const environment = {
    HOME: home,
    PATH: path || defaultLaunchdPath({ nodeExe, home }),
  };
  if (gateHome) environment.VERSUTUS_GATE_HOME = gateHome;
  if (host) environment.VERSUTUS_GATE_HOST = host;
  if (port !== undefined && port !== null) environment.VERSUTUS_GATE_PORT = String(port);

  const s = (value) => `<string>${escapePlistString(value)}</string>`;
  const k = (value) => `<key>${escapePlistString(value)}</key>`;
  const envLines = Object.entries(environment)
    .map(([name, value]) => `\t\t${k(name)}\n\t\t${s(value)}`)
    .join('\n');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t${k('Label')}
\t${s(label)}
\t${k('ProgramArguments')}
\t<array>
${programArguments.map((arg) => `\t\t${s(arg)}`).join('\n')}
\t</array>
\t${k('WorkingDirectory')}
\t${s(codeRoot)}
\t${k('EnvironmentVariables')}
\t<dict>
${envLines}
\t</dict>
\t${k('RunAtLoad')}
\t<true/>
\t${k('KeepAlive')}
\t<dict>
\t\t${k('SuccessfulExit')}
\t\t<false/>
\t</dict>
\t${k('ThrottleInterval')}
\t<integer>10</integer>
\t${k('ProcessType')}
\t${s('Standard')}
\t${k('Umask')}
\t<integer>63</integer>
\t${k('StandardInPath')}
\t${s('/dev/null')}
\t${k('StandardOutPath')}
\t${s(stdoutPath)}
\t${k('StandardErrorPath')}
\t${s(stderrPath)}
</dict>
</plist>
`;
  return { label, plist, programArguments, environment, workingDirectory: codeRoot, logDir, stdoutPath, stderrPath };
}

/**
 * Read the fields `service status` reports out of `launchctl print`. The
 * first `state =` / `pid =` lines are the job's own; nested blocks (endpoints,
 * event triggers) come later and carry their own `state`.
 */
export function parseLaunchctlPrint(text = '') {
  const first = (re) => {
    const match = re.exec(text);
    return match ? match[1].trim() : null;
  };
  const pid = first(/^\s*pid = (\d+)\s*$/m);
  return {
    state: first(/^\s*state = (.+)$/m),
    pid: pid === null ? null : Number(pid),
    lastExitCode: first(/^\s*last exit code = (.+)$/m),
    path: first(/^\s*path = (.+)$/m),
    host: first(/^\s*VERSUTUS_GATE_HOST => (.+)$/m),
    port: first(/^\s*VERSUTUS_GATE_PORT => (\d+)\s*$/m),
  };
}

/** One plain sentence for a parsed `launchctl print`. */
export function describeLaunchdState(info) {
  if (info.state === 'running') return `running${info.pid ? ` (pid ${info.pid})` : ''}`;
  if (info.state === 'spawn scheduled') return 'restarting (launchd will start it again shortly)';
  const exit = info.lastExitCode ? `; last exit code ${info.lastExitCode}` : '';
  return `loaded but not running (${info.state ?? 'state unknown'}${exit})`;
}

/** Default command runner: never throws, always says what happened. */
export function runCommand(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return {
    status: result.status ?? (result.error ? 127 : 1),
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ?? null,
  };
}

const quote = (arg) => (/^[A-Za-z0-9_./:=@%+-]+$/.test(arg) ? arg : `'${String(arg).replace(/'/g, `'\\''`)}'`);
const show = (command, args) => [command, ...args].map(quote).join(' ');
const detail = (result) => (result.stderr || result.stdout || result.error?.message || '').trim() || `exit ${result.status}`;
// `launchctl bootout` of a job that is not loaded: "No such process" (3).
const notLoaded = (result) => result.status === 3 || /no such process|could not find service/i.test(`${result.stderr}${result.stdout}`);

function context({ label = LAUNCHD_LABEL, uid }) {
  if (!Number.isInteger(uid)) throw new Error('could not determine your user id for launchctl (gui/<uid>)');
  const domain = `gui/${uid}`;
  return { domain, target: `${domain}/${label}` };
}

function isLoaded(run, target) {
  return run('launchctl', ['print', target]).status === 0;
}

/**
 * Write the plist and (re)load it into the user's GUI domain.
 * Idempotent: an agent already loaded under the label is booted out first,
 * then bootstrapped from the new plist — that is how launchd picks up a
 * changed plist at all.
 */
export async function installLaunchAgent({
  agent,
  plistPath,
  backupPath,
  uid,
  dryRun = false,
  run = runCommand,
  out = console.log,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  bootstrapAttempts = 5,
}) {
  const { domain, target } = context({ label: agent.label, uid });
  const steps = [
    [show('launchctl', ['print', target]), 'check whether it is already loaded'],
    [show('launchctl', ['bootout', target]), 'only if already loaded'],
    [show('launchctl', ['bootstrap', domain, plistPath]), 'load and start it'],
  ];
  const replacing = existsSync(plistPath);
  if (dryRun) {
    out(`Dry run: nothing written, nothing loaded.`);
    if (replacing) out(`Would replace the existing ${plistPath} (a copy is kept at ${backupPath ?? 'no backup path'})`);
    out(`Would write ${plistPath}:`);
    out(agent.plist.trimEnd());
    out('Would run:');
    for (const [command, why] of steps) out(`  ${command}   # ${why}`);
    return { ok: true, dryRun: true };
  }

  if (replacing && backupPath) {
    // The plist being replaced may be hand-written (Ethan's was): keep it.
    try {
      mkdirSync(posix.dirname(backupPath), { recursive: true });
      copyFileSync(plistPath, backupPath);
      out(`replacing ${plistPath}; the previous one is saved at ${backupPath}`);
    } catch (error) {
      return { ok: false, message: `Could not back up the existing ${plistPath} to ${backupPath} (${error.message}). Nothing was changed.` };
    }
  }

  try {
    mkdirSync(agent.logDir, { recursive: true });
    mkdirSync(posix.dirname(plistPath), { recursive: true });
    const temp = `${plistPath}.${process.pid}.tmp`;
    writeFileSync(temp, agent.plist, { mode: 0o644 });
    renameSync(temp, plistPath);
  } catch (error) {
    return { ok: false, message: `Could not write the LaunchAgent file ${plistPath}: ${error.message}` };
  }

  const lint = run('plutil', ['-lint', plistPath]);
  if (lint.error?.code === 'ENOENT') {
    out('note: plutil not found, skipping the plist syntax check');
  } else if (lint.status !== 0) {
    return { ok: false, message: `The LaunchAgent file ${plistPath} is not a valid plist (plutil -lint: ${detail(lint)}). Nothing was loaded.` };
  }

  const wasLoaded = isLoaded(run, target);
  if (wasLoaded) {
    out(`${agent.label} is already loaded; reloading it from the new plist`);
    const bootout = run('launchctl', ['bootout', target]);
    if (bootout.status !== 0 && !notLoaded(bootout)) {
      return { ok: false, message: `Could not unload the running ${agent.label} to reload it (launchctl bootout: ${detail(bootout)}). The new plist is written at ${plistPath}; the old agent is still loaded.` };
    }
  }

  // bootout returns before launchd has finished tearing the job down, and a
  // bootstrap in that window fails with "5: Input/output error" — retry.
  let bootstrap;
  for (let attempt = 1; attempt <= bootstrapAttempts; attempt += 1) {
    bootstrap = run('launchctl', ['bootstrap', domain, plistPath]);
    if (bootstrap.status === 0) break;
    if (attempt < bootstrapAttempts) await sleep(1000);
  }
  if (bootstrap.status !== 0) {
    return {
      ok: false,
      message: `launchd refused to load ${agent.label} (launchctl bootstrap: ${detail(bootstrap)}). `
        + `The plist is at ${plistPath}; check it with \`plutil -lint\` and the logs in ${agent.logDir}.`,
    };
  }
  if (!isLoaded(run, target)) {
    return { ok: false, message: `launchctl bootstrap reported success but ${target} is not loaded. Check ${agent.stderrPath}.` };
  }
  return { ok: true, reloaded: wasLoaded };
}

/** Unload the agent and delete its plist. Not installed is not an error. */
export function uninstallLaunchAgent({
  label = LAUNCHD_LABEL,
  plistPath,
  uid,
  dryRun = false,
  run = runCommand,
  out = console.log,
}) {
  const { target } = context({ label, uid });
  if (dryRun) {
    out('Dry run: nothing unloaded, nothing deleted.');
    out('Would run:');
    out(`  ${show('launchctl', ['bootout', target])}   # only if loaded`);
    out(`  ${show('rm', [plistPath])}`);
    return { ok: true, dryRun: true };
  }
  const loaded = isLoaded(run, target);
  if (loaded) {
    const bootout = run('launchctl', ['bootout', target]);
    if (bootout.status !== 0 && !notLoaded(bootout)) {
      return { ok: false, message: `Could not unload ${label} (launchctl bootout: ${detail(bootout)}). Nothing was deleted.` };
    }
  }
  const hadFile = existsSync(plistPath);
  if (hadFile) {
    try {
      rmSync(plistPath, { force: true });
    } catch (error) {
      return { ok: false, message: `Unloaded ${label} but could not delete ${plistPath}: ${error.message}. It will load again at next login until that file is removed.` };
    }
  }
  return { ok: true, wasInstalled: loaded || hadFile };
}

/**
 * Report the agent's launchd state plus whether the Gate actually answers.
 * ok only when launchd says running AND the manifest is reachable — the same
 * verdict the Windows `service status` gives.
 */
export async function launchAgentStatus({
  label = LAUNCHD_LABEL,
  plistPath,
  uid,
  port = 8760,
  run = runCommand,
  probe,
  out = console.log,
}) {
  const { target } = context({ label, uid });
  const printed = run('launchctl', ['print', target]);
  if (printed.status !== 0) {
    if (existsSync(plistPath)) {
      out(`${label}: installed at ${plistPath} but not loaded. Run \`node gate/cli.mjs service start\` (or \`service install\`) to load it.`);
    } else {
      out(`${label}: not installed. Run \`node gate/cli.mjs service install\` to install it.`);
    }
    return { ok: false, loaded: false };
  }
  const info = parseLaunchctlPrint(printed.stdout);
  out(`${label}: ${describeLaunchdState(info)}`);
  out(`  plist: ${info.path ?? plistPath}`);
  if (info.host) out(`  bind address: ${info.host} (VERSUTUS_GATE_HOST)`);
  const probePort = info.port ? Number(info.port) : port;
  const probeHost = info.host && !/^(0\.0\.0\.0|::|\[::\])$/.test(info.host) ? info.host : '127.0.0.1';
  const hostPart = probeHost.includes(':') ? `[${probeHost}]` : probeHost;
  let reachable = false;
  if (probe) {
    const result = await probe(`http://${hostPart}:${probePort}/.well-known/gateway.json`);
    reachable = Boolean(result?.reachable);
    out(`manifest: ${reachable ? 'reachable' : 'UNREACHABLE'} (${result?.detail ?? 'no detail'})`);
  }
  return { ok: info.state === 'running' && reachable, loaded: true, info, reachable };
}

/** `service start`: load the installed plist, or kick an already-loaded agent. */
export function startLaunchAgent({ label = LAUNCHD_LABEL, plistPath, uid, dryRun = false, run = runCommand, out = console.log }) {
  const { domain, target } = context({ label, uid });
  if (dryRun) {
    out('Dry run: would run');
    out(`  ${show('launchctl', ['bootstrap', domain, plistPath])}   # if not loaded`);
    out(`  ${show('launchctl', ['kickstart', target])}   # if loaded`);
    return { ok: true, dryRun: true };
  }
  if (isLoaded(run, target)) {
    const kick = run('launchctl', ['kickstart', target]);
    return kick.status === 0 ? { ok: true } : { ok: false, message: `Could not start ${label} (launchctl kickstart: ${detail(kick)}).` };
  }
  if (!existsSync(plistPath)) {
    return { ok: false, message: `${label} is not installed (${plistPath} does not exist). Run \`node gate/cli.mjs service install\` first.` };
  }
  const boot = run('launchctl', ['bootstrap', domain, plistPath]);
  return boot.status === 0 ? { ok: true } : { ok: false, message: `launchd refused to load ${label} (launchctl bootstrap: ${detail(boot)}).` };
}

/**
 * `service stop`: unload the agent but keep its plist, so it stays stopped
 * until `service start` or the next login. A plain kill would not stop it —
 * KeepAlive restarts a Gate that dies on a signal.
 */
export function stopLaunchAgent({ label = LAUNCHD_LABEL, uid, dryRun = false, run = runCommand, out = console.log }) {
  const { target } = context({ label, uid });
  if (dryRun) {
    out(`Dry run: would run\n  ${show('launchctl', ['bootout', target])}`);
    return { ok: true, dryRun: true };
  }
  const bootout = run('launchctl', ['bootout', target]);
  if (bootout.status === 0 || notLoaded(bootout)) return { ok: true, wasRunning: bootout.status === 0 };
  return { ok: false, message: `Could not stop ${label} (launchctl bootout: ${detail(bootout)}).` };
}

/** `service restart`: launchd kills and restarts the job in one step. */
export function restartLaunchAgent({ label = LAUNCHD_LABEL, uid, dryRun = false, run = runCommand, out = console.log }) {
  const { target } = context({ label, uid });
  if (dryRun) {
    out(`Dry run: would run\n  ${show('launchctl', ['kickstart', '-k', target])}`);
    return { ok: true, dryRun: true };
  }
  const kick = run('launchctl', ['kickstart', '-k', target]);
  if (kick.status === 0) return { ok: true };
  if (notLoaded(kick)) return { ok: false, message: `${label} is not loaded. Run \`node gate/cli.mjs service start\` or \`service install\`.` };
  return { ok: false, message: `Could not restart ${label} (launchctl kickstart -k: ${detail(kick)}).` };
}

export const LAUNCHD_USAGE = 'Usage: node gate/cli.mjs service <install|uninstall|status|start|stop|restart> [--dry-run] [--host <ip>] [--port <n>] [--node <path>]';

/**
 * The whole macOS `service` command, with every system touchpoint injectable
 * so tests run it against a temp folder and a fake launchctl. Returns the
 * process exit code; never calls process.exit itself.
 */
export async function runLaunchdService(sub, args = [], {
  env = process.env,
  uid = typeof process.getuid === 'function' ? process.getuid() : undefined,
  nodeExe = process.execPath,
  codeRoot,
  agentsDir,
  run = runCommand,
  probe,
  sleep,
  out = console.log,
  err = console.error,
} = {}) {
  const fail = (message) => {
    err(`Error: ${message}`);
    return 1;
  };
  const home = env.HOME;
  if (!home) return fail('HOME is not set, so there is no ~/Library/LaunchAgents to install into');
  const dryRun = args.includes('--dry-run');
  const plistPath = launchAgentPath({ home, agentsDir });
  const common = { label: LAUNCHD_LABEL, plistPath, uid, dryRun, run, out };

  try {
    if (sub === 'install') {
      const hostResolution = resolveStartHost(args, env);
      if (hostResolution.error) return fail(hostResolution.error);
      const portResolution = resolveStartPort(args, env);
      if (portResolution.error) return fail(portResolution.error);
      const hostGiven = args.includes('--host') || Boolean(env.VERSUTUS_GATE_HOST?.trim());
      const portGiven = args.includes('--port') || Boolean(env.VERSUTUS_GATE_PORT);
      const nodeIndex = args.indexOf('--node');
      let nodePath = nodeExe;
      if (nodeIndex !== -1) {
        nodePath = args[nodeIndex + 1];
        if (!nodePath || nodePath.startsWith('--') || !posix.isAbsolute(nodePath)) return fail('--node expects the absolute path of the node binary to run the Gate with');
        if (!existsSync(nodePath)) return fail(`--node: ${nodePath} does not exist`);
      }
      const gateHome = env.VERSUTUS_GATE_HOME || undefined;
      const backupPath = posix.join(gateHome || resolveGateHome({ HOME: home }, 'darwin'), 'service', `${LAUNCHD_LABEL}.plist.previous`);
      const agent = buildLaunchAgent({
        nodeExe: nodePath,
        codeRoot,
        home,
        gateHome,
        host: hostGiven ? hostResolution.host : undefined,
        port: portGiven ? portResolution.port : undefined,
      });
      const result = await installLaunchAgent({ agent, plistPath, backupPath, uid, dryRun, run, out, ...(sleep ? { sleep } : {}) });
      if (!result.ok) return fail(result.message);
      if (!dryRun) {
        out(`service installed: ${agent.label} ${result.reloaded ? 'reloaded' : 'loaded'} from ${plistPath}`);
        out(`  runs ${agent.programArguments.join(' ')} in ${codeRoot}`);
        out(`  bind address: ${agent.environment.VERSUTUS_GATE_HOST ?? '127.0.0.1 (default; pass --host 0.0.0.0 for tailnet/LAN access)'}`);
        out(`  logs: ${agent.stdoutPath}, ${agent.stderrPath}`);
        out('  check it with: node gate/cli.mjs service status');
      }
      return 0;
    }
    if (sub === 'uninstall') {
      const result = uninstallLaunchAgent(common);
      if (!result.ok) return fail(result.message);
      if (!dryRun) out(result.wasInstalled ? 'service uninstalled' : `service was not installed (no ${plistPath}); nothing to do`);
      return 0;
    }
    if (sub === 'status') {
      const portResolution = resolveStartPort(args, env);
      if (portResolution.error) return fail(portResolution.error);
      const result = await launchAgentStatus({ ...common, port: portResolution.port, probe });
      return result.ok ? 0 : 1;
    }
    if (sub === 'start') {
      const result = startLaunchAgent(common);
      if (!result.ok) return fail(result.message);
      if (!dryRun) out('service started');
      return 0;
    }
    if (sub === 'stop') {
      const result = stopLaunchAgent(common);
      if (!result.ok) return fail(result.message);
      if (!dryRun) out(result.wasRunning ? 'service stopped (it starts again at next login or with `service start`)' : 'service was not running');
      return 0;
    }
    if (sub === 'restart') {
      const result = restartLaunchAgent(common);
      if (!result.ok) return fail(result.message);
      if (!dryRun) out('service restarted');
      return 0;
    }
    if (sub === 'run') {
      return fail('`service run` is the Windows supervisor. On macOS launchd supervises the Gate itself: use `service install`.');
    }
  } catch (error) {
    return fail(error.message);
  }
  err(LAUNCHD_USAGE);
  return 1;
}

/** What `service` says on a platform with no service backend yet. */
export function unsupportedServiceMessage(platform = process.platform) {
  return `Error: \`service\` is not supported on ${platform} yet (Windows Scheduled Task and macOS LaunchAgent only). `
    + 'Run the Gate with `node gate/cli.mjs start` under your own process manager (e.g. a systemd user unit).';
}
