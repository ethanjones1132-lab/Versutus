import { GATEWAY_COMMANDS } from '@/lib/gateway/dashboard';
import type { GatewayCommand } from '@/lib/gateway/dashboard';
import { commandPanelCaption, commandPanelHasCaption } from '@/lib/gateway/command-panel';

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

function entry(overrides: Partial<GatewayCommand> = {}): GatewayCommand {
  return {
    id: 'session-usage',
    label: 'Session usage',
    group: 'Sessions',
    transport: 'rpc',
    danger: 'safe',
    ...overrides,
  };
}

const panel = () =>
  readSource('src', 'components', 'gateway', 'gateway-command-panel.tsx');

test('a registry entry captions its method', () => {
  const usage = GATEWAY_COMMANDS.find((command) => command.id === 'session-usage');
  expect(usage).toBeDefined();
  expect(commandPanelCaption(entry({ method: 'session.usage', slash: '/session usage' }))).toBe(
    'session.usage',
  );
  expect(commandPanelHasCaption(entry({ method: 'session.usage' }))).toBe(true);
});

test('an entry with no method falls back to its slash', () => {
  expect(commandPanelCaption(entry({ slash: '/agent status' }))).toBe('/agent status');
  expect(commandPanelHasCaption(entry({ slash: '/agent status' }))).toBe(true);
});

test('an entry naming no call keeps the label-only button, never a guess', () => {
  expect(commandPanelCaption(entry())).toBeUndefined();
  expect(commandPanelHasCaption(entry())).toBe(false);
});

test('blank method and slash count as absent, not as captions', () => {
  expect(commandPanelCaption(entry({ method: '   ', slash: '  ' }))).toBeUndefined();
  expect(commandPanelHasCaption(entry({ method: '', slash: '' }))).toBe(false);
});

test('a slash without a method still captions when the method is blank', () => {
  expect(commandPanelCaption(entry({ method: '  ', slash: '/health' }))).toBe('/health');
});

test('the panel captions buttons from the entry fields with no new data', () => {
  const src = panel();
  expect(src).toContain('commandPanelCaption');
  expect(src).toContain('commandCaption');
  expect(src).not.toContain('gatewayRequest(');
  expect(src).not.toContain('fetch(');
});

test('run behaviour, the write mark, and the Running/disabled states hold', () => {
  const src = panel();
  // A row says Running while its command is in flight, and every row holds
  // while any command runs.
  expect(src).toContain('const running = runningCommandId === command.id;');
  expect(src).toContain("{running ? 'Running' : command.label}");
  expect(src).toContain('disabled={!!runningCommandId}');
  // A command that writes carries its own amber mark rather than the colour
  // every safe read wears.
  expect(src).toContain("const writes = command.danger === 'write';");
  expect(src).toContain("color={writes ? 'statusConnecting' : 'accent'}");
  expect(src).toContain('onRun(command);');
});

test('the Raw output sheet trigger stays untouched', () => {
  const src = panel();
  expect(src).toContain('label="Raw"');
  expect(src).toContain('onOpenOutput');
});
