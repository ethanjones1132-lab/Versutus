import { GATEWAY_COMMANDS } from '@/lib/gateway/dashboard';
import {
  buildRpcMethodSlashMap,
  normalizeRpcMethods,
  rpcMethodsListCopy,
  rpcMethodSlash,
} from '@/lib/gateway/rpc-methods';

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

test('a mapped method resolves to the slash the registry already holds', () => {
  const map = buildRpcMethodSlashMap(GATEWAY_COMMANDS);
  expect(rpcMethodSlash('session.usage', map)).toBe('/session usage');
  expect(rpcMethodSlash('session.get', map)).toBe('/session get');
  expect(rpcMethodSlash('cron.list', map)).toBe('/cron list');
});

test('a method the registry does not know keeps the bare name, never a guess', () => {
  const map = buildRpcMethodSlashMap(GATEWAY_COMMANDS);
  expect(rpcMethodSlash('cron.runs', map)).toBeUndefined();
  expect(rpcMethodSlash('nope.unknown', map)).toBeUndefined();
  expect(rpcMethodSlash('', map)).toBeUndefined();
});

test('dynamic instance commands join the same map without guessing', () => {
  const map = buildRpcMethodSlashMap([
    ...GATEWAY_COMMANDS,
    { method: 'cron.runs', slash: '/cron history' },
  ]);
  expect(rpcMethodSlash('cron.runs', map)).toBe('/cron history');
});

test('the map keeps the first slash and skips entries with no method or slash', () => {
  const map = buildRpcMethodSlashMap([
    { method: 'session.usage', slash: '/session usage' },
    { method: 'session.usage', slash: '/later wins' },
    { method: '', slash: '/empty' },
    { method: 'no.slash', slash: '' },
    { slash: '/no-method' },
  ]);
  expect(map['session.usage']).toBe('/session usage');
  expect(map['no.slash']).toBeUndefined();
  expect(map['']).toBeUndefined();
});

test('an absent table still means unknown, never none', () => {
  expect(normalizeRpcMethods(undefined)).toBeUndefined();
  expect(rpcMethodsListCopy(undefined)).toBe(
    'This gateway does not report which RPC methods it answers.',
  );
  expect(rpcMethodsListCopy(undefined)).not.toBe('No RPC methods reported.');
});

test('the section subtitles rows from the already-held registry with no new fetch', () => {
  const src = section();
  expect(src).toContain('capabilitySnapshot.rpcMethods');
  expect(src).toContain('buildRpcMethodSlashMap');
  expect(src).toContain('rpcMethodSlash');
  expect(src).toContain('GATEWAY_COMMANDS');
  expect(src).toContain('manifestDynamicCommands');
  expect(src).toContain('subtitle');
  expect(src).not.toContain('gatewayRequest(');
  expect(src).not.toContain('registry.kinds.list');
  expect(src).not.toContain('registry.instances');
});

test('the section stays display-only and collapsed by default', () => {
  const src = section();
  expect(src).toContain('useState<string | null>(null)');
  expect(src).toContain('openFor === gatewayId');
  expect(src).toContain('Answered RPC methods');
  const rows = src.match(/<ListRow[^>]*>/g) ?? [];
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) expect(row).not.toContain('onPress');
});

test('snapshot-block judgments stay untouched', () => {
  const src = section();
  expect(src).not.toContain('not dispatched by this gateway');
  expect(src).not.toContain('dispatchesMethod');
});
