import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { probeVersion } from './shared.mjs';
import { createHermesBackend } from '../backends/hermes.mjs';

/**
 * Which Hermes install this environment belongs to.
 *
 * Two homes exist on a typical host: the one the operator installed into, and
 * the bare `~/.hermes` the CLI creates by default. Only one has `profiles/`,
 * and picking the wrong one does NOT fail loudly — the Gate serves the single
 * implicit `default` bot and then 401s with "Invalid gateway API key", because
 * that home's `.env` carries a different key. A 14-bot fleet silently became
 * one this way (2026-08-25) when the Gate happened to start without
 * HERMES_HOME in its environment.
 *
 * So the ambient variable is preferred but no longer required: the environment
 * record already names the executable, and a Hermes install puts it at
 * `<home>/hermes-agent/venv/{bin,Scripts}/hermes*`. That marker is evidence,
 * not a guess — and when it is absent we fall back to the CLI's own default
 * rather than inventing a path.
 */
export function resolveHermesHome({
  env = process.env,
  executablePath,
  homedir: home = homedir(),
  hasProfiles = (dir) => existsSync(join(dir, 'profiles')),
} = {}) {
  const explicit = typeof env.HERMES_HOME === 'string' ? env.HERMES_HOME.trim() : '';

  const marker = /^(.*)[\\/]hermes-agent[\\/]venv[\\/](?:bin|Scripts)[\\/]hermes(?:\.exe)?$/i
    .exec(String(executablePath ?? ''));
  const derived = marker ? marker[1] : '';

  const fallback = join(home, '.hermes');

  // Evidence beats assertion. Preferring the ambient variable outright is what
  // let a single stale launcher take the fleet down on 2026-08-26: something
  // started the Gate exporting HERMES_HOME=~/.hermes, that home holds no
  // profiles/, and a 14-bot roster silently became the one implicit `default`
  // while every route answered "Invalid gateway API key". The variable is a
  // claim; a profiles/ directory is proof. Whichever candidate actually holds
  // one wins, whatever the environment asserts.
  for (const candidate of [explicit, derived, fallback]) {
    if (candidate && hasProfiles(candidate)) return candidate;
  }

  // No candidate has profiles yet — a fresh install, before the first bot
  // exists. Keep the declared order so a first run still lands where the
  // operator pointed us rather than somewhere invented.
  return explicit || derived || fallback;
}

export const hermesAdapter = {
  adapterId: 'hermes',
  adapterRevision: '1',
  supportedCliVersions: '0.18.x-0.20.x',
  protocolVersions: { acp: '1' },
  // `skills`, `diagnostics`, `cron` and `bots` are fronted by the Gate over
  // this backend's passthroughs. They are declared here because `backendCan(...)`
  // in manifest.mjs is what turns each into an advertised endpoint.
  capabilities: ['chat', 'tools', 'mcp', 'sessions', 'models', 'runs', 'skills', 'diagnostics', 'cron', 'bots'],
  operations: {
    prompt: {
      inputSchema: { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' } } },
      risk: 'workspace_write',
      machineReadable: true,
    },
    status: {
      inputSchema: { type: 'object', properties: {} },
      risk: 'read',
      machineReadable: true,
    },
    interactive: {
      inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
      risk: 'credential',
      machineReadable: false,
    },
  },
  /**
   * Hermes runs as a long-lived service, not a per-turn CLI: 8642 is where an
   * operator's own instance already listens, so attach rather than spawn. The
   * spawn args are the documented fallback for a host with none running.
   */
  server: {
    defaultPort: 8642,
    healthPath: '/health',
    args: (port) => ['gateway', 'run', '--port', String(port)],
    portFromOutput: (line) => /listening on https?:\/\/[^:]+:(\d+)/.exec(line)?.[1],
  },

  /** Sessions, the 47-provider model catalog, runs and skills, owned by Hermes. */
  createBackend({ baseUrl, credentials, record } = {}) {
    // Hermes authenticates every route with API_SERVER_KEY. Without it the
    // backend attaches happily and then 401s on the first real call.
    return createHermesBackend({
      baseUrl,
      apiKey: credentials?.API_SERVER_KEY ?? credentials?.HERMES_API_SERVER_KEY,
      profilesHome: resolveHermesHome({ executablePath: record?.executable?.path }),
      executablePath: record?.executable?.path,
    });
  },

  async probe(executablePath) {
    return probeVersion(executablePath, {
      min: '0.18.0',
      maxExclusiveMajor: 1,
      protocol: 'acp',
      handshakeArgs: ['--acp', '--probe'],
    });
  },
  /**
   * Non-interactive argv per operation, read off the real CLI's usage line
   * (`hermes -h`): `-z PROMPT` runs one bounded task and prints the reply,
   * `--version` is the call probe() already makes. The long-lived service
   * stays with server/createBackend; this is the per-task spawn the
   * supervisor executes inside the workspace. Returns null for an operation
   * that needs a real terminal, so the run fails honestly instead of
   * completing empty.
   */
  runInvocation(operation, input = {}) {
    if (operation === 'status') return { args: ['--version'] };
    if (operation === 'prompt') {
      const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
      if (!prompt) return null;
      return { args: ['-z', prompt] };
    }
    return null;
  },
};
