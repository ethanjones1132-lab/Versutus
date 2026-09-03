import { backendChipHasFreshness, backendChipLabel } from '@/lib/gateway/backend-freshness';
import type { GatewayBackend } from '@/lib/portal/manifest';

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

function backend(overrides: Partial<GatewayBackend> = {}): GatewayBackend {
  return {
    id: 'hermes-local',
    label: 'Hermes',
    kind: 'environment',
    ...overrides,
  };
}

test('a ready backend chip carries its state and CLI version', () => {
  expect(
    backendChipLabel(backend({ state: 'ready', cliVersion: '1.2.3' })),
  ).toBe('Hermes · ready · 1.2.3');
});

test('a backend with state but no version still carries its state', () => {
  expect(backendChipLabel(backend({ state: 'stopped' }))).toBe(
    'Hermes · stopped',
  );
});

test('absent state keeps today label-only chip, never a guessed state', () => {
  expect(backendChipLabel(backend())).toBe('Hermes');
  expect(backendChipHasFreshness(backend())).toBe(false);
});

test('blank state counts as absent, not as freshness', () => {
  expect(backendChipLabel(backend({ state: '   ' }))).toBe('Hermes');
  expect(backendChipHasFreshness(backend({ state: '  ' }))).toBe(false);
});

test('a version without state keeps the label-only chip', () => {
  expect(backendChipLabel(backend({ cliVersion: '1.2.3' }))).toBe('Hermes');
  expect(backendChipHasFreshness(backend({ cliVersion: '1.2.3' }))).toBe(
    false,
  );
});

test('a blank version with state shows state alone', () => {
  expect(backendChipLabel(backend({ state: 'ready', cliVersion: '  ' }))).toBe(
    'Hermes · ready',
  );
  expect(
    backendChipHasFreshness(backend({ state: 'ready', cliVersion: '  ' })),
  ).toBe(true);
});

test('the setup screen subtitles chips from the held manifest with no new fetch', () => {
  const setup = readSource('src', 'app', 'gateway', 'setup.tsx');
  expect(setup).toContain('backendChipLabel');
  expect(setup).not.toContain('gatewayRequest(');
  expect(setup).not.toContain('fetch(');
  expect(setup).not.toContain('/v1/backends');
});

test('the selected-backend semantics stay untouched', () => {
  const setup = readSource('src', 'app', 'gateway', 'setup.tsx');
  expect(setup).toContain('selectedBackendId');
  expect(setup).toContain('const activeBackendId = selectedBackendId;');
  expect(setup).not.toContain('?? backends[0]');
  expect(setup).not.toContain('|| backends[0]');
});

test('the thread-sheet backend rows and the chat header chip stay untouched', () => {
  const sheet = readSource(
    'src',
    'components',
    'chat',
    'thread-config-sheet.tsx',
  );
  expect(sheet).not.toContain('backendChipLabel');
  expect(sheet).toContain('item.cliVersion');
  const header = readSource('src', 'components', 'chat', 'chat-header.tsx');
  expect(header).not.toContain('backendChipLabel');
});
