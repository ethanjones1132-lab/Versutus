// Live smoke for the RPC-style command surface, called directly against the
// gate's HTTP routes — the same path `client.rpcRequest` takes app-side.
//
// This replaces a version that shelled out to the separate `openclaw` npm
// CLI's `gateway call` subcommand. That CLI targets a different product's
// daemon/handshake and hung indefinitely (0/18, uniform 5s timeouts) against
// this repo's bespoke Hermes-dialect gate — a transport bug in the smoke
// harness, not evidence the gate was broken. Calling the route map directly
// means this can never drift from what the app actually does, and it
// distinguishes a genuinely missing mapping from a method this Hermes
// dialect deliberately does not expose (METHOD_GUIDANCE).
//
// Run: npx tsx scripts/smoke-gateway-commands.mts [baseUrl]
//   Defaults to the local Gate (http://127.0.0.1:8760), reading its token
//   from gate/.tokens.json. Override with OPENCLAW_GATEWAY_URL /
//   OPENCLAW_GATEWAY_TOKEN for any other gateway.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

// identify.ts pulls in adapters that import react-native transitively;
// install the same minimal Platform shim smoke-live-gateway.mts uses so it
// loads under tsx/esbuild.
const nodeRequire = createRequire(import.meta.url);
const Module = nodeRequire('module') as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};
const originalLoad = Module._load.bind(Module);
Module._load = (request: string, parent: unknown, isMain: boolean) => {
  if (request === 'react-native') {
    return { Platform: { OS: 'node', select: (spec: Record<string, unknown>) => spec.default ?? spec.native ?? spec.web } };
  }
  return originalLoad(request, parent, isMain);
};

const { identifyGateway } = await import('../src/lib/portal/identify');
const { METHOD_GUIDANCE, resolveRoute } = await import('../src/lib/gateway/rpc-routes');

const timeoutMs = Number(process.env.OPENCLAW_COMMAND_TIMEOUT_MS ?? 5000);

function readGateToken(): string | undefined {
  try {
    const raw = readFileSync(join(process.cwd(), 'gate', '.tokens.json'), 'utf8');
    return (JSON.parse(raw) as { token?: string }).token;
  } catch {
    return undefined;
  }
}

const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL ?? process.argv[2] ?? 'http://127.0.0.1:8760';
const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN ?? readGateToken();

const checks: { slash: string; method: string; params?: Record<string, unknown> }[] = [
  { slash: '/health', method: 'health' },
  { slash: '/status', method: 'status' },
  { slash: '/sessions', method: 'sessions.list', params: { limit: 10 } },
  { slash: '/channels', method: 'channels.status' },
  { slash: '/usage', method: 'usage.status' },
  { slash: '/cost', method: 'usage.cost' },
  { slash: '/stability', method: 'diagnostics.stability' },
  { slash: '/logs', method: 'logs.tail', params: { limit: 20, maxBytes: 12000 } },
  { slash: '/models', method: 'models.list' },
  { slash: '/model', method: 'config.get' },
  { slash: '/model auth', method: 'models.authStatus' },
  { slash: '/config', method: 'config.get' },
  { slash: '/plugins', method: 'plugins.uiDescriptors' },
  { slash: '/approvals', method: 'exec.approvals.get' },
  { slash: '/memory', method: 'doctor.memory.status' },
  { slash: '/skills', method: 'skills.status' },
  { slash: '/env', method: 'environments.status' },
  { slash: '/cron', method: 'cron.status' },
];

type Row = {
  slash: string;
  method: string;
  status: 'pass' | 'unsupported' | 'not-hermes' | 'fail';
  note: string;
  durationMs: number;
};

async function callGateway(check: (typeof checks)[number], gatewayIsHermes: boolean): Promise<Omit<Row, 'slash' | 'method'>> {
  const started = Date.now();
  const resolved = resolveRoute(check.method, check.params ?? {});

  if (!resolved) {
    const guidance = METHOD_GUIDANCE[check.method];
    return guidance
      ? { status: 'unsupported', note: guidance, durationMs: Date.now() - started }
      : { status: 'fail', note: 'no route mapped and no guidance recorded — genuinely missing', durationMs: Date.now() - started };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${gatewayUrl}${resolved.path}`, {
      method: resolved.route.method,
      headers: {
        ...(gatewayToken ? { Authorization: `Bearer ${gatewayToken}` } : {}),
        'Content-Type': 'application/json',
      },
      body: resolved.route.method === 'GET' ? undefined : JSON.stringify(resolved.body),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      // The route map (rpc-routes.ts) describes Hermes' REST surface
      // specifically. A 404 against a non-Hermes gate means this route was
      // never expected to exist here — the app's capability snapshot gates
      // these off before a slash command can reach them. Only a 404 against
      // an actual Hermes gate, or a non-404 error against anything, is real.
      const status = !gatewayIsHermes && response.status === 404 ? 'not-hermes' : 'fail';
      return { status, note: `HTTP ${response.status} ${compactLine(text)}`, durationMs: Date.now() - started };
    }
    return { status: 'pass', note: summarizePayload(text), durationMs: Date.now() - started };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 'fail', note: compactLine(message), durationMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

function summarizePayload(text: string): string {
  try {
    const value = JSON.parse(text);
    if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
    if (value && typeof value === 'object') return `${Object.keys(value).length} keys`;
  } catch {
    // not JSON — fall through
  }
  return 'completed';
}

function compactLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 180);
}

async function main() {
  const identity = await identifyGateway({ baseUrl: gatewayUrl });
  const gatewayIsHermes = identity.kind === 'hermes';
  console.log(`Gateway: ${gatewayUrl} (identified as ${identity.kindLabel})`);
  console.log(`Token: ${gatewayToken ? `loaded (${gatewayToken.length} chars)` : 'NOT FOUND — unauthenticated checks only'}`);
  if (!gatewayIsHermes) {
    console.log(
      'This route map describes the Hermes REST surface; a 404 on a Hermes-only\n' +
        'path against this non-Hermes gate is expected (the app gates these off\n' +
        'via the capability snapshot) and reported as NOT-HERMES, not FAIL.',
    );
  }
  console.log('');

  const rows: Row[] = [];
  for (const check of checks) {
    const result = await callGateway(check, gatewayIsHermes);
    rows.push({ ...check, ...result });
  }

  for (const row of rows) {
    const label = row.status.toUpperCase().padEnd(11);
    const duration = `${row.durationMs}ms`.padStart(7);
    console.log(`${label} ${duration} ${row.slash.padEnd(13)} ${row.method} — ${row.note}`);
  }

  const passed = rows.filter((r) => r.status === 'pass');
  const unsupported = rows.filter((r) => r.status === 'unsupported');
  const notHermes = rows.filter((r) => r.status === 'not-hermes');
  const failed = rows.filter((r) => r.status === 'fail');

  console.log(
    `\nGateway command smoke: ${passed.length} passed, ${unsupported.length} unsupported by design, ` +
      `${notHermes.length} Hermes-only route on a non-Hermes gate, ${failed.length} failed`,
  );
  process.exitCode = failed.length > 0 ? 1 : 0;
}

void main();
