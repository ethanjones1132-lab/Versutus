import { GATEWAY_COMMANDS, summarizeCommandResult } from '@/lib/gateway/dashboard';
import type { GatewayCommand } from '@/lib/gateway/dashboard';

function gatewayCommand(id: 'health' | 'status'): GatewayCommand {
  const command = GATEWAY_COMMANDS.find((entry) => entry.id === id);
  if (!command) throw new Error(`missing gateway command: ${id}`);
  return command;
}

// VS-016: this summary is the one-liner the terminal shows in chat. A missing
// state used to fall back to `OK`/`online`, so a refused, empty or malformed
// payload looked like a healthy gateway. Only a read state may say healthy.
describe('gateway summaries never invent a healthy state', () => {
  const health = gatewayCommand('health');
  const status = gatewayCommand('status');

  test('an empty health payload is unknown, not OK', () => {
    expect(summarizeCommandResult(health, {})).toBe('Health: unknown');
  });

  test('a non-object health payload is unknown', () => {
    expect(summarizeCommandResult(health, null)).toBe('Health: unknown');
    expect(summarizeCommandResult(health, 'not a payload')).toBe('Health: unknown');
    expect(summarizeCommandResult(health, ['health'])).toBe('Health: unknown');
  });

  test('a health payload whose status is not a string is unknown', () => {
    expect(summarizeCommandResult(health, { status: 200 })).toBe('Health: unknown');
  });

  test('a real health state still prints verbatim', () => {
    expect(summarizeCommandResult(health, { status: 'degraded' })).toBe('Health: degraded');
    expect(summarizeCommandResult(health, { state: 'ok' })).toBe('Health: ok');
  });

  test('an empty status payload is unknown, not online', () => {
    expect(summarizeCommandResult(status, {})).toBe('Status: unknown');
  });

  test('a non-object status payload is unknown', () => {
    expect(summarizeCommandResult(status, null)).toBe('Status: unknown');
    expect(summarizeCommandResult(status, 42)).toBe('Status: unknown');
  });

  test('a status payload whose status is not a string is unknown', () => {
    expect(summarizeCommandResult(status, { status: 200 })).toBe('Status: unknown');
  });

  test('unknown keeps the version when one was read', () => {
    expect(summarizeCommandResult(status, { version: '1.4.2' })).toBe('Status: unknown - 1.4.2');
  });

  test('a real status still prints verbatim, with its version', () => {
    expect(summarizeCommandResult(status, { status: 'online' })).toBe('Status: online');
    expect(summarizeCommandResult(status, { status: 'online', version: '1.4.2' })).toBe(
      'Status: online - 1.4.2',
    );
  });
});
