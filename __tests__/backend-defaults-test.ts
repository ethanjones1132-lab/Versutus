import { backendScore, resolveDefaultBackend } from '@/lib/gateway/backend-defaults';
import type { GatewayBackend } from '@/lib/portal/manifest';

const backend = (id: string, capabilities: string[]): GatewayBackend => ({
  id,
  label: id,
  kind: 'environment',
  capabilities,
});

// The four this Gate actually advertises, in the order it advertises them.
const CLAUDE = backend('claude-local', ['chat', 'stream-json', 'mcp', 'sessions', 'tools', 'models']);
const CODEX = backend('codex-local', ['exec', 'jsonl', 'mcp', 'sessions', 'tools', 'models']);
const HERMES = backend('hermes-local', [
  'chat', 'tools', 'mcp', 'sessions', 'models', 'runs', 'skills', 'diagnostics', 'cron', 'bots',
]);
const OPENCODE = backend('opencode-local', ['acp', 'run-json', 'mcp', 'sessions', 'tools', 'models']);

const REAL_FLEET = [CLAUDE, CODEX, HERMES, OPENCODE];

test('a cold start lands on Hermes, not on whichever backend is listed first', () => {
  // The reported bug: backends[0] is claude-local, so the setup screen showed
  // Claude Code as selected and every launch needed a manual switch.
  expect(resolveDefaultBackend(REAL_FLEET)).toBe('hermes-local');
});

test('it picks by capability rather than by the name "hermes"', () => {
  // A differently-named environment offering the same surfaces must win too,
  // otherwise the rule is a vendor check wearing a capability costume.
  const other = backend('acme-agents', ['chat', 'bots', 'sessions', 'models', 'tools']);
  expect(resolveDefaultBackend([CLAUDE, other])).toBe('acme-agents');
});

test('a backend that cannot chat is never the chat default', () => {
  // codex-local and opencode-local declare no `chat`; only claude can here.
  expect(resolveDefaultBackend([CODEX, OPENCODE, CLAUDE])).toBe('claude-local');
  expect(backendScore(CODEX)).toBe(-1);
  expect(backendScore(OPENCODE)).toBe(-1);
});

test('an explicit choice survives reconnecting', () => {
  // Switching backend is deliberate; a reconnect must not quietly undo it.
  expect(resolveDefaultBackend(REAL_FLEET, 'claude-local')).toBe('claude-local');
});

test('a remembered backend the Gate dropped falls back instead of stranding', () => {
  expect(resolveDefaultBackend(REAL_FLEET, 'retired-local')).toBe('hermes-local');
});

test('no backends yet is distinguishable from a resolved pick', () => {
  expect(resolveDefaultBackend([])).toBeUndefined();
  expect(resolveDefaultBackend(undefined)).toBeUndefined();
});

test('ties keep declaration order so the pick does not flap between launches', () => {
  const first = backend('first', ['chat', 'sessions']);
  const second = backend('second', ['chat', 'sessions']);
  expect(resolveDefaultBackend([first, second])).toBe('first');
  expect(resolveDefaultBackend([second, first])).toBe('second');
});

test('a fleet where nothing can chat still yields a selection to correct', () => {
  expect(resolveDefaultBackend([CODEX, OPENCODE])).toBe('codex-local');
});
