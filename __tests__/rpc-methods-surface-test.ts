import { buildCapabilitySnapshot } from '@/lib/gateway/dashboard';
import {
  normalizeRpcMethods,
  rpcMethodsListCopy,
  rpcMethodsToggleLabel,
} from '@/lib/gateway/rpc-methods';
import type { GatewayCapabilities } from '@/lib/gateway/types';

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(...parts: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

const section = () =>
  readSource('src', 'components', 'gateway', 'rpc-methods-section.tsx');

function gateCapabilities(methods: unknown): GatewayCapabilities {
  return {
    object: 'manifest-derived.capabilities',
    platform: 'gate',
    model: '',
    auth: { type: 'bearer', required: false },
    runtime: { mode: 'gate', tool_execution: 'remote', split_runtime: false, description: '' },
    features: {},
    endpoints: {},
    rpcMethods: methods as string[],
  } as unknown as GatewayCapabilities;
}

test('an advertised list normalizes to a sorted, deduplicated read', () => {
  expect(normalizeRpcMethods(['session.get', 'cron.runs', 'session.get', '  ', 7])).toEqual([
    'cron.runs',
    'session.get',
  ]);
});

test('an absent list stays unknown, never an empty table', () => {
  expect(normalizeRpcMethods(undefined)).toBeUndefined();
  expect(normalizeRpcMethods(null)).toBeUndefined();
  expect(normalizeRpcMethods({})).toBeUndefined();
  expect(rpcMethodsListCopy(undefined)).toBe(
    'This gateway does not report which RPC methods it answers.',
  );
  expect(rpcMethodsListCopy(undefined)).not.toBe('No RPC methods reported.');
});

test('an empty report reads as none, a populated one needs no copy', () => {
  expect(normalizeRpcMethods([])).toEqual([]);
  expect(rpcMethodsListCopy([])).toBe('No RPC methods reported.');
  expect(rpcMethodsListCopy(['session.get'])).toBeUndefined();
});

test('the toggle is collapsed by default and counts only a known list', () => {
  expect(rpcMethodsToggleLabel(false, undefined)).toBe('Answered RPC methods');
  expect(rpcMethodsToggleLabel(false, 3)).toBe('Answered RPC methods (3)');
  expect(rpcMethodsToggleLabel(true, 3)).toBe('Hide methods');
});

test('the snapshot carries the advertised table and keeps unknown unknown', () => {
  const advertised = buildCapabilitySnapshot(
    'connected',
    null,
    undefined,
    Date.now(),
    gateCapabilities(['session.get', 'session.get', 'cron.runs']),
  );
  expect(advertised.rpcMethods).toEqual(['cron.runs', 'session.get']);
  const hermes = buildCapabilitySnapshot(
    'connected',
    null,
    undefined,
    Date.now(),
    gateCapabilities(undefined),
  );
  expect(hermes.rpcMethods).toBeUndefined();
  expect('rpcMethods' in hermes).toBe(false);
});

test('the section reads the already-held snapshot with no new fetch', () => {
  const src = section();
  expect(src).toContain('capabilitySnapshot.rpcMethods');
  expect(src).toContain('normalizeRpcMethods');
  expect(src).toContain('rpcMethodsListCopy');
  expect(src).toContain('rpcMethodsToggleLabel');
  expect(src).not.toContain('gatewayRequest(');
  expect(src).not.toContain('registry.kinds.list');
  expect(src).not.toContain('registry.instances');
});

test('the section is collapsed by default and display-only', () => {
  const src = section();
  expect(src).toContain('useState<string | null>(null)');
  expect(src).toContain('openFor === gatewayId');
  expect(src).toContain('Answered RPC methods');
  expect(src).toContain('<ListRow key={method} title={method}');
  // Rows carry no press handler — the table is read-only (the collapsed
  // toggle Button above them is the only pressable).
  const rows = src.match(/<ListRow[^>]*>/g) ?? [];
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) expect(row).not.toContain('onPress');
});

test('the methods block lives beside the capabilities section on the Gateway screen', () => {
  const setup = readSource('src', 'app', 'gateway', 'setup.tsx');
  expect(setup).toContain('RpcMethodsSection');
  const route = readSource('src', 'app', 'gateway', 'capabilities.tsx');
  expect(route).toContain('RpcMethodsSection');
});

test('snapshot-block judgments and the registry views stay untouched', () => {
  const src = section();
  expect(src).not.toContain('not dispatched by this gateway');
  expect(src).not.toContain('dispatchesMethod');
  expect(src).not.toContain("slash: '/tools'");
  const dashboard = readSource('src', 'lib', 'gateway', 'dashboard.ts');
  expect(dashboard).toContain('not dispatched by this gateway');
});
