import {
  gatewayIdentityRows,
  gatewayIdentityUnknownNote,
} from '@/lib/gateway/gateway-identity';
import type { GatewayManifest } from '@/lib/portal/manifest';

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
  readSource('src', 'components', 'gateway', 'gateway-identity-section.tsx');

function fullManifest(): GatewayManifest {
  return {
    manifest: 'versutus-gateway/v1',
    kind: 'hermes',
    name: 'Ethan Gate',
    version: '1.2.3',
    vendor: 'Nous',
    capabilities: {
      chat: true,
      runs: true,
      terminal: false,
      sessions: true,
      models: true,
      approvals: false,
    },
  } as GatewayManifest;
}

test('a full manifest renders name, kind, version, vendor, and capability flags', () => {
  const rows = gatewayIdentityRows(fullManifest());
  const byLabel = Object.fromEntries(rows.map((row) => [row.label, row.value]));
  expect(byLabel.Name).toBe('Ethan Gate');
  expect(byLabel.Gateway).toBe('Hermes');
  expect(byLabel.Version).toBe('1.2.3');
  expect(byLabel.Vendor).toBe('Nous');
  expect(byLabel.Capabilities).toContain('chat');
  expect(byLabel.Capabilities).toContain('runs');
  expect(byLabel.Capabilities).not.toContain('terminal');
  expect(gatewayIdentityUnknownNote(fullManifest())).toBeNull();
});

test('a partial manifest degrades to an honest unknown note, never blank or none', () => {
  const partial = fullManifest();
  delete (partial as Partial<GatewayManifest>).name;
  delete (partial as Partial<GatewayManifest>).version;
  delete (partial as Partial<GatewayManifest>).vendor;
  delete (partial as Partial<GatewayManifest>).capabilities;
  const rows = gatewayIdentityRows(partial);
  // The kind row always renders, so the block is never blank.
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.some((row) => row.label === 'Name')).toBe(false);
  const note = gatewayIdentityUnknownNote(partial);
  expect(note).not.toBeNull();
  expect(note as string).toContain('name');
  expect(note as string).toContain('vendor');
  expect(note as string).toContain('capability flags');
  expect(note as string).not.toMatch(/no gateway|none/i);
});

test('a missing manifest names the unknown instead of an empty block', () => {
  expect(gatewayIdentityRows(null)).toEqual([]);
  const note = gatewayIdentityUnknownNote(null);
  expect(note).not.toBeNull();
  expect(note as string).not.toBe('');
});

test('blank strings count as absent, not as identity', () => {
  const blank = { ...fullManifest(), name: '   ', version: '', vendor: '  ' };
  const rows = gatewayIdentityRows(blank);
  expect(rows.some((row) => row.label === 'Name')).toBe(false);
  expect(rows.some((row) => row.label === 'Version')).toBe(false);
  expect(rows.some((row) => row.label === 'Vendor')).toBe(false);
  expect(gatewayIdentityUnknownNote(blank)).not.toBeNull();
});

test('a present-but-empty capability set reads as none enabled, not unknown', () => {
  const quiet = { ...fullManifest(), capabilities: { chat: false } };
  const rows = gatewayIdentityRows(quiet);
  expect(rows.find((row) => row.label === 'Capabilities')?.value).toBe(
    'none enabled',
  );
  expect(gatewayIdentityUnknownNote(quiet)).toBeNull();
});

test('the section reads the already-held manifest with no new fetch', () => {
  const src = section();
  expect(src).toContain('activeManifest');
  expect(src).toContain('gatewayIdentityRows');
  expect(src).toContain('gatewayIdentityUnknownNote');
  expect(src).not.toContain('gatewayRequest(');
  expect(src).not.toContain('fetch(');
  expect(src).not.toContain('rpcMethods');
  expect(src).not.toContain('backends');
});

test('the identity block sits above the section tabs on the Gate setup screen', () => {
  const setup = readSource('src', 'app', 'gateway', 'setup.tsx');
  expect(setup).toContain('GatewayIdentitySection');
  expect(setup.indexOf('<GatewayIdentitySection')).toBeLessThan(
    setup.indexOf('<SegmentedControl'),
  );
});

test('the backend picker and capability sections stay untouched', () => {
  const setup = readSource('src', 'app', 'gateway', 'setup.tsx');
  expect(setup).toContain('selectedBackendId');
  expect(setup).toContain('const activeBackendId = selectedBackendId;');
  expect(setup).toContain('ProvidersSection');
  expect(setup).toContain('CapabilitiesSection');
  expect(setup).toContain('GatewayManagementSection');
});

test('the provider exposes the held manifest with no new store', () => {
  const provider = readSource('src', 'context', 'gateway-provider.tsx');
  expect(provider).toContain('activeManifest,');
  expect(provider.match(/useState<GatewayManifest/g) ?? []).toHaveLength(1);
});
