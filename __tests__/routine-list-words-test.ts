import type { ActivityCoverage } from '@/lib/gateway/activity-feed';
import { routineCoverageLine, unsetBotsLabel } from '@/lib/routines/coverage';
import { routineNextRunLabel } from '@/lib/routines/next-run';
import { routineStatusWord } from '@/lib/routines/status';

// VS-133: the Routines list speaks in words. These pin the three phrases the
// row and its coverage line print, away from the wire's raw values.

function coverage(
  status: ActivityCoverage['status'],
  error?: string,
): ActivityCoverage {
  return { id: 'hermes', label: 'Hermes', status, ...(error ? { error } : {}) };
}

const UNSET_LIST =
  'Bot anvil could not be read; Bot bounty could not be read; Bot closer could not be read';

describe('the coverage line carries a count and one reason', () => {
  test('a complete read is its count, or a plain none', () => {
    expect(routineCoverageLine(coverage('complete'), 0)).toEqual({ text: 'none', failed: false });
    expect(routineCoverageLine(coverage('complete'), 1)).toEqual({ text: '1 routine', failed: false });
    expect(routineCoverageLine(coverage('complete'), 5)).toEqual({ text: '5 routines', failed: false });
  });

  test('a backend with no routine concept stays quiet and neutral', () => {
    expect(routineCoverageLine(coverage('unavailable'), 0)).toEqual({
      text: 'not supported here',
      failed: false,
    });
  });

  test('Bots that are not set up are counted, never printed as their raw list', () => {
    const line = routineCoverageLine(coverage('partial', UNSET_LIST), 5);
    expect(line).toEqual({ text: "5 routines · 3 Bots aren't set up yet", failed: false });
    expect(line.text).not.toContain(';');
    expect(line.text).not.toContain('could not be read');
  });

  test('one Bot not set up reads in the singular', () => {
    expect(unsetBotsLabel(1)).toBe("1 Bot isn't set up yet");
    expect(routineCoverageLine(coverage('partial', 'Bot anvil could not be read'), 1)).toEqual({
      text: "1 routine · 1 Bot isn't set up yet",
      failed: false,
    });
  });

  test('a partial read keeps its count, the setup count, and one real reason', () => {
    const line = routineCoverageLine(
      coverage(
        'partial',
        'Backend routine read timed out; Bot anvil could not be read; Bot bounty could not be read',
      ),
      2,
    );
    expect(line.text).toBe("2 routines · 2 Bots aren't set up yet · Backend routine read timed out");
    expect(line.failed).toBe(false);
  });

  test('a list the Gate cut at its length cap still counts its last Bot', () => {
    const capped = Array.from({ length: 6 }, (_, index) => `Bot bot${index} could not be read`)
      .join('; ')
      .slice(0, 160);
    const line = routineCoverageLine(coverage('partial', capped), 5);
    expect(line).toEqual({ text: "5 routines · 6 Bots aren't set up yet", failed: false });
    expect(line.text).not.toContain(';');
  });

  test('a failed roster read is a real reason, not a Bot that needs setup', () => {
    const line = routineCoverageLine(
      coverage('partial', 'Bot roster could not be read; Bot anvil could not be read'),
      2,
    );
    expect(line.text).toBe("2 routines · 1 Bot isn't set up yet · Bot roster could not be read");
    expect(line.failed).toBe(false);
    expect(routineCoverageLine(coverage('failed', 'Bot roster could not be read'), 0)).toEqual({
      text: 'Bot roster could not be read',
      failed: true,
    });
    expect(routineCoverageLine(coverage('failed', 'Default Bot could not be read'), 0)).toEqual({
      text: 'Default Bot could not be read',
      failed: true,
    });
  });

  test('several real reasons still show only the first sentence', () => {
    const line = routineCoverageLine(
      coverage('partial', 'read timed out; socket hang up; host refused'),
      3,
    );
    expect(line.text).toBe('3 routines · read timed out');
    expect(line.text).not.toContain('socket hang up');
  });

  test('a real failure is red and one sentence', () => {
    const line = routineCoverageLine(coverage('failed', 'Backend routine read timed out'), 0);
    expect(line).toEqual({ text: 'Backend routine read timed out', failed: true });
  });

  test('a failed read whose only trouble is setup stays neutral', () => {
    const line = routineCoverageLine(coverage('failed', UNSET_LIST), 0);
    expect(line).toEqual({ text: "3 Bots aren't set up yet", failed: false });
  });

  test('a failed read never claims a routine count it did not receive', () => {
    expect(routineCoverageLine(coverage('failed'), 0)).toEqual({
      text: 'could not be read',
      failed: true,
    });
    expect(routineCoverageLine(coverage('failed', 'read timed out'), 0).text).not.toContain('routine');
  });

  test('a partial read with no reason still says some could not be read', () => {
    expect(routineCoverageLine(coverage('partial'), 2)).toEqual({
      text: '2 routines · some could not be read',
      failed: false,
    });
  });
});

describe('the status words are readable, never wire values', () => {
  test('known verdicts get a sentence', () => {
    expect(routineStatusWord('ok')).toBe('Last run OK');
    expect(routineStatusWord('error')).toBe('Last run failed');
    expect(routineStatusWord('failed')).toBe('Last run failed');
    expect(routineStatusWord('blocked_config')).toBe('Needs setup');
  });

  test('paused keeps its existing word and outranks the last run', () => {
    expect(routineStatusWord('ok', true)).toBe('Paused');
    expect(routineStatusWord(undefined, true)).toBe('Paused');
  });

  test('a routine that never ran says so', () => {
    expect(routineStatusWord(undefined)).toBe('Not run yet');
    expect(routineStatusWord('   ')).toBe('Not run yet');
  });

  test('an unknown value is repeated in a capitalised readable form', () => {
    expect(routineStatusWord('rate_limited')).toBe('Rate limited');
    expect(routineStatusWord('quarantined')).toBe('Quarantined');
    expect(routineStatusWord('awaitingInput')).toBe('Awaiting input');
    expect(routineStatusWord('blockedConfig')).toBe('Needs setup');
    expect(routineStatusWord('rate_limited')).not.toContain('_');
  });
});

describe('one next-run format for the list', () => {
  const now = Date.parse('2026-08-25T09:00:00Z');
  const format = { locale: 'en-US', timeZone: 'UTC' };
  const after = (ms: number) => new Date(now + ms).toISOString();

  test('under an hour counts minutes', () => {
    expect(routineNextRunLabel(after(25 * 60_000), now)).toBe('in 25 min');
  });

  test('under a day counts hours', () => {
    expect(routineNextRunLabel(after(3 * 60 * 60_000), now)).toBe('in 3 h');
    expect(routineNextRunLabel(after(23 * 60 * 60_000), now)).toBe('in 23 h');
  });

  test('the 24-hour boundary switches to weekday and time', () => {
    expect(routineNextRunLabel(after(24 * 60 * 60_000), now, format)).toBe('Wed 9:00 AM');
    expect(routineNextRunLabel(after(24 * 60 * 60_000 + 60_000), now, format)).toBe('Wed 9:01 AM');
    // The far form carries no relative word at all.
    expect(routineNextRunLabel(after(48 * 60 * 60_000), now, format)).not.toContain('in ');
  });

  test('a run that is due or past says due, not a negative countdown', () => {
    expect(routineNextRunLabel(after(-60_000), now)).toBe('due');
    expect(routineNextRunLabel(after(10_000), now)).toBe('due');
  });

  test('an unreadable timestamp is unknown, never a wrong promise', () => {
    expect(routineNextRunLabel('not-a-date', now)).toBeNull();
  });
});
