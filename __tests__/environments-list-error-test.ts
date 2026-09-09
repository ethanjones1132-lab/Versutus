declare const __dirname: string;

import { createEnvironmentClient } from '@/lib/gateway/environment-client';
import type { EnvironmentSnapshot } from '@/lib/gateway/environment-types';

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(rel: string[]): string {
  return nodeFs.readFileSync([__dirname, '..', ...rel].join(SEP), 'utf8').replace(/\r\n/g, '\n');
}

function readClient(): string {
  return readSource(['src', 'lib', 'gateway', 'environment-client.ts']);
}

function readSection(): string {
  return readSource(['src', 'components', 'gateway', 'environments-section.tsx']);
}

const SNAPSHOT: EnvironmentSnapshot = {
  id: 'hermes-local',
  label: 'Hermes (local)',
  adapterId: 'hermes',
  enabled: true,
  providerRefs: [],
  state: 'ready',
  executable: { path: '/usr/bin/hermes' },
  protocolPreference: ['acp'],
  workspacePolicy: { defaultRoot: '/tmp', defaultSandbox: 'read_only' },
  lifecycle: { startup: 'on_demand', maxConcurrentRuns: 1 },
};

// `createEnvironmentClient.list` used to swallow every `environments.list`
// rejection into `{ environments: [] }`, so `EnvironmentsSection.load` never
// entered its catch and the EmptyState read as an empty Gate. list() now
// rejects the way `createProviderClient.list` does; the section ErrorCard
// names the refusal, and adapters/providers extras still degrade on their own.
describe('environments list names a refusal instead of an empty Gate', () => {
  test('list() no longer swallows a refused environments.list into an empty array', () => {
    const src = readClient();
    const listAt = src.indexOf("'environments.list'");
    expect(listAt).toBeGreaterThanOrEqual(0);
    const listBlock = src.slice(listAt, src.indexOf('check:', listAt));
    expect(listBlock).not.toContain('.catch(() => ({ environments: [] }))');
  });

  test('list() rejects when the request rejects', async () => {
    const client = createEnvironmentClient(async () => {
      throw new Error('environments.list is not available on this Gate');
    });
    await expect(client.list()).rejects.toThrow('environments.list is not available on this Gate');
  });

  test('a successful empty list still returns [] so EmptyState can render honestly', async () => {
    const client = createEnvironmentClient(async <T,>() => ({ environments: [] }) as T);
    await expect(client.list()).resolves.toEqual([]);
  });

  test('list() still unwraps a wrapped payload and a bare array', async () => {
    const wrapped = createEnvironmentClient(async <T,>() => ({ environments: [SNAPSHOT] }) as T);
    await expect(wrapped.list()).resolves.toEqual([SNAPSHOT]);
    const bare = createEnvironmentClient(async <T,>() => [SNAPSHOT] as T);
    await expect(bare.list()).resolves.toEqual([SNAPSHOT]);
  });

  test('load still catches a refused list into the section ErrorCard', () => {
    const src = readSection();
    expect(src).toContain('setEnvironments(await client.list());');
    expect(src).toContain('setError(caught instanceof Error ? caught.message : String(caught));');
    expect(src).toContain('affected="CLI environments on this Gate"');
    expect(src).toContain('onRetry={() => void load()}');
  });

  test('a genuinely empty successful list still renders the EmptyState', () => {
    const src = readSection();
    expect(src).toContain('title="No CLI environments yet"');
    expect(src).toContain(
      'description="Attach a CLI such as OpenCode, Codex or Claude Code to this Gate."',
    );
    expect(src).toContain(
      '{loaded && environments.length === 0 && !registering && !editing && status === \'connected\' ? (',
    );
  });

  test('adapters and providers extras still degrade independently on older Gates', () => {
    const src = readSection();
    expect(src).toContain('setAdapters(await client.listAdapters());');
    expect(src).toContain('setAdapters([]);');
    expect(src).toContain('setProviders(await providerClient.list());');
    expect(src).toContain('setProviders([]);');
  });
});
