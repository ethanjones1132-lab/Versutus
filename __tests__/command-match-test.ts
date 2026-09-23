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

  test('/workflow delete <name> matches as danger destructive so the confirmation sheet fires', () => {
    const match = findConfirmableSlash('/workflow delete nightly-report');
    expect(match).toMatchObject({ slash: '/workflow delete', danger: 'destructive' });
    expect(match?.label).toBe('Remove workflow');
  });

  test('/workflow new and /workflow rename match as danger write', () => {
    expect(findConfirmableSlash('/workflow new ship | step one')).toMatchObject({
      slash: '/workflow new',
      danger: 'write',
    });
    expect(findConfirmableSlash('/workflow rename old | new name')).toMatchObject({
      slash: '/workflow rename',
      danger: 'write',
    });
  });

  test('bare /workflow (the list) stays unconfirmed', () => {
    expect(findConfirmableSlash('/workflow')).toBeUndefined();
  });

  test('/workflow <name> (the run) stays unconfirmed like /run', () => {
    // dashboard.ts run-task registers /run danger safe; a workflow run rides
    // the same runTask path with approval gates, so the composer must not put
    // a second sheet in front of every run.
    expect(findConfirmableSlash('/workflow nightly-report')).toBeUndefined();
  });

  test('/workflow delete with no name is a run attempt, not a removal', () => {
    // The dispatcher enters management only on `delete<whitespace>`; alone the
    // word is a workflow name to run, so it must never read as destructive.
    expect(findConfirmableSlash('/workflow delete')).toBeUndefined();
  });
});
