import { describe, expect, test } from '@jest/globals';
import { outcomeToActivityStatus, type RunOutcome } from '@/lib/gateway/runs';
import { runSlashStatusWord } from '@/lib/gateway/run-status-verdict';

/**
 * /run's "Run complete / Run <status>" verdict used a hardcoded status regex
 * inside runTaskCommand while the reducer that produced the outcome already
 * carries outcomeToActivityStatus — the real mapping that keeps `unresolved`
 * distinct from every terminal verdict. The slash verdict must be that same
 * mapping, not a second English guess.
 */

describe('runSlashStatusWord', () => {
  test('a completed outcome reads complete — "Run complete"', () => {
    const outcome: RunOutcome = { runId: 'r1', status: 'completed', result: 'ok' };
    expect(runSlashStatusWord(outcome)).toBe('complete');
  });

  test('a failed outcome reads the verdict the Activity tab folds, not the English guess', () => {
    const outcome: RunOutcome = { runId: 'r1', status: 'failed' };
    expect(runSlashStatusWord(outcome)).toBe('failed');
  });

  test('the line word can be pinned against the shared mapping itself', () => {
    const outcome: RunOutcome = { runId: 'r1', status: 'error', error: 'boom' };
    expect(outcomeToActivityStatus(outcome)).toBe('failed');
    expect(runSlashStatusWord(outcome)).toBe(outcomeToActivityStatus(outcome));
  });

  test('an unresolved outcome never reads as complete', () => {
    const outcome: RunOutcome = { runId: 'r1', status: 'running', unresolved: true };
    expect(outcomeToActivityStatus(outcome)).toBe('unresolved');
    expect(runSlashStatusWord(outcome)).toBe('running');
  });

  test('a cancelled outcome reads cancelled', () => {
    const outcome: RunOutcome = { runId: 'r1', status: 'cancelled' };
    expect(runSlashStatusWord(outcome)).toBe('cancelled');
  });
});
