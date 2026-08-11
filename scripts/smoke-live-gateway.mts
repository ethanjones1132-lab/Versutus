// Live smoke against a running gateway (Hermes, Gate, or any conforming kind).
//
// Identifies the target via identifyGateway, constructs the appropriate
// PortalClient via createClientForKind, and exercises the real connect path
// and capability snapshot. Token lookup is kind-specific (Hermes .env vs
// gate/.tokens.json) and the key is never printed.
//
// Run: npx tsx scripts/smoke-live-gateway.mts [baseUrl]
//   Hermes (default): npm run smoke:live
//   Gate:             npm run smoke:live -- http://127.0.0.1:8760

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { buildCapabilitySnapshot } from '../src/lib/gateway/dashboard';
import type { ConnectionStatus, GatewayCapabilities, GatewayKind, GatewayProfile } from '../src/lib/gateway/types';

// adapters → OpenClawAdapterClient → openclaw-client imports react-native.
// Under tsx/esbuild that module cannot be transformed; install a minimal
// Platform shim before the dynamic import of createClientForKind.
const nodeRequire = createRequire(import.meta.url);
const Module = nodeRequire('module') as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};
const originalLoad = Module._load.bind(Module);
Module._load = (request: string, parent: unknown, isMain: boolean) => {
  if (request === 'react-native') {
    return {
      Platform: {
        OS: 'node',
        select: (spec: Record<string, unknown>) => spec.default ?? spec.native ?? spec.web,
      },
    };
  }
  return originalLoad(request, parent, isMain);
};

const { createClientForKind } = await import('../src/lib/portal/adapters');
const { identifyGateway } = await import('../src/lib/portal/identify');

const BASE_URL = process.argv[2] ?? 'http://127.0.0.1:8642';
let failures = 0;

function check(label: string, condition: boolean, detail = '') {
  const mark = condition ? 'PASS' : 'FAIL';
  if (!condition) failures += 1;
  console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ''}`);
}

function readApiKey(): string | undefined {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return undefined;
  try {
    const contents = readFileSync(join(localAppData, 'hermes', '.env'), 'utf8');
    const line = contents.split(/\r?\n/).find((entry) => entry.startsWith('API_SERVER_KEY='));
    return line?.slice('API_SERVER_KEY='.length).replace(/^["']|["']$/g, '').trim() || undefined;
  } catch {
    return undefined;
  }
}

function readGateToken(): string | undefined {
  // The Gate prints its token on `cli.mjs start`; for smoke testing, read it
  // from gate/.tokens.json directly rather than requiring the operator to
  // copy it out of console output each run.
  try {
    const raw = readFileSync(join(process.cwd(), 'gate', '.tokens.json'), 'utf8');
    const parsed = JSON.parse(raw) as { token?: string };
    return parsed.token;
  } catch {
    return undefined;
  }
}

function profileWith(kind: GatewayKind, token?: string): GatewayProfile {
  return { id: 'smoke', name: 'Live gateway', url: BASE_URL, kind, token, createdAt: 0 };
}

async function main() {
  const identity = await identifyGateway({ baseUrl: BASE_URL });
  // Kind-specific first; fall back so a Hermes that fingerprints as unknown
  // (e.g. /v1/capabilities requires the key before the probe can see it)
  // still picks up API_SERVER_KEY for authenticated checks.
  const key =
    identity.kind === 'hermes'
      ? readApiKey() ?? readGateToken()
      : identity.kind === 'custom'
        ? readGateToken() ?? readApiKey()
        : readApiKey() ?? readGateToken();
  console.log(`Gateway: ${BASE_URL} (identified as ${identity.kindLabel})`);
  console.log(`Token: ${key ? `loaded (${key.length} chars)` : 'NOT FOUND — authenticated checks skipped'}\n`);

  console.log('Valid key — connect path');
  if (!key) {
    console.log('  [SKIP] no token available');
  } else {
    const statuses: ConnectionStatus[] = [];
    let capabilities: GatewayCapabilities | null = null;
    const client = createClientForKind(
      identity.kind,
      profileWith(identity.kind, key),
      {
        onStatus: (status) => statuses.push(status),
        onCapabilities: (caps) => {
          capabilities = caps;
        },
      },
      identity,
    );

    await client.connect();
    check('reaches connected', client.connectionStatus === 'connected', client.connectionStatus);
    check('publishes capabilities from connect()', capabilities !== null);
    check('no reconnecting during a clean connect', !statuses.includes('reconnecting'));

    if (capabilities) {
      const snapshot = buildCapabilitySnapshot('connected', null, undefined, Date.now(), capabilities);
      check('snapshot is fresh', snapshot.status === 'fresh', snapshot.status);
      check(
        'no group stuck warming',
        snapshot.groups.every((group) => group.status !== 'warming'),
      );

      const approvals = snapshot.groups.find((group) => group.id === 'approvals');
      check('approvals resolves ready', approvals?.status === 'ready', approvals?.status);

      console.log('\n  Capability groups:');
      for (const group of snapshot.groups) {
        const counts = group.totalCount ? ` ${group.availableCount}/${group.totalCount}` : '';
        console.log(`    ${group.status === 'ready' ? '+' : '-'} ${group.label.padEnd(14)} ${group.status}${counts}`);
      }
    }
    client.disconnect();
  }

  console.log('\nRejected key — must fail fast, not loop');
  {
    const client = createClientForKind(
      identity.kind,
      profileWith(identity.kind, 'definitely-not-a-valid-key'),
      {},
      identity,
    );
    let rejected: Error | null = null;
    try {
      await client.connect();
    } catch (error) {
      rejected = error instanceof Error ? error : new Error(String(error));
    }
    check('connect() rejects', rejected !== null, rejected?.message ?? 'resolved');
    check('message names the API key', /api key/i.test(rejected?.message ?? ''));
    check('ends disconnected, not reconnecting', client.connectionStatus === 'disconnected', client.connectionStatus);
    client.disconnect();
  }

  console.log(`\n${failures === 0 ? 'All live checks passed.' : `${failures} check(s) failed.`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
