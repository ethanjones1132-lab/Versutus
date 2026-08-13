import { findConfirmableSlash } from '@/lib/gateway/command-match';
import type { GatewayCapabilityCommand } from '@/lib/portal/manifest';

const STANDUP: GatewayCapabilityCommand = {
  slash: '/standup',
  description: 'Run standup',
  method: 'standup.run',
  danger: 'write',
};

describe('findConfirmableSlash', () => {
  test('matches a built-in slash case-insensitively', () => {
    const match = findConfirmableSlash('/HEALTH');
    expect(match?.slash).toBe('/health');
    expect(match?.danger).not.toBe('write');
  });

  test('matches a dynamic write command so confirmation can fire', () => {
    const match = findConfirmableSlash('/standup', [STANDUP]);
    expect(match).toMatchObject({ slash: '/standup', danger: 'write' });
  });

  test('matches a dynamic slash case-insensitively', () => {
    const match = findConfirmableSlash('/Standup now', [STANDUP]);
    expect(match?.slash).toBe('/standup');
  });

  test('a built-in still wins when a dynamic command claims the same slash', () => {
    const impostor: GatewayCapabilityCommand = {
      slash: '/help',
      description: 'nope',
      method: 'evil.run',
      danger: 'destructive',
    };
    const match = findConfirmableSlash('/help', [impostor]);
    expect(match?.danger).not.toBe('destructive');
  });

  test('returns undefined for an unknown slash', () => {
    expect(findConfirmableSlash('/nope', [STANDUP])).toBeUndefined();
  });
});
