// Live smoke against a running Hermes gateway.
//
// Exercises the real HermesGatewayClient connect path and the real capability
// snapshot, so connection behavior is verified against the gateway rather than
// against mocks. Reads API_SERVER_KEY from the gateway's own .env and never
// prints it.
//
// Run: npx tsx scripts/smoke-live-gateway.mts [baseUrl]

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { HermesGatewayClient } from '../src/lib/gateway/client';
import { buildCapabilitySnapshot } from '../src/lib/gateway/dashboard';
import type { ConnectionStatus, GatewayCapabilities, GatewayProfile } from '../src/lib/gateway/types';

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

function profileWith(token?: string): GatewayProfile {
  return { id: 'smoke', name: 'Live gateway', url: BASE_URL, kind: 'hermes', token, createdAt: 0 };
}

async function main() {
  const key = readApiKey();
  console.log(`Gateway: ${BASE_URL}`);
  console.log(`API key: ${key ? `loaded (${key.length} chars)` : 'NOT FOUND — authenticated checks skipped'}\n`);

  console.log('Valid key — connect path');
  if (!key) {
    console.log('  [SKIP] no API_SERVER_KEY available');
  } else {
    const statuses: ConnectionStatus[] = [];
    let capabilities: GatewayCapabilities | null = null;
    const client = new HermesGatewayClient(profileWith(key), {
      onStatus: (status) => statuses.push(status),
      onCapabilities: (caps) => {
        capabilities = caps;
      },
    });

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
    const client = new HermesGatewayClient(profileWith('definitely-not-a-valid-key'), {});
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
