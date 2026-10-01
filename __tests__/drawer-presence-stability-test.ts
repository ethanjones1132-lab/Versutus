import { samePresence, teamPresence } from '@/lib/activity/presence';
import type { ActivityRun } from '@/lib/gateway/runs';

/**
 * `samePresence` is what lets the drawer KEEP the presence map it already has:
 * `teamPresence` folds a new map on every call, so without this comparison a run
 * event that moves no Bot between "working" and "needs you" arrives as a
 * different object and the memoised team rows cannot tell it from a real change.
 */
function run(id: string, botId: string | undefined, status: ActivityRun['status']): ActivityRun {
  return { id, botId, status, prompt: id, startedAt: 0, events: [] };
}

describe('samePresence', () => {
  test('the same map is its own match, however it was folded', () => {
    const presence = teamPresence([run('a', 'forge', 'running')]);
    expect(samePresence(presence, presence)).toBe(true);
    expect(samePresence(teamPresence([]), teamPresence([]))).toBe(true);
  });

  test('two maps that say the same thing match', () => {
    const a = teamPresence([run('a', 'forge', 'running'), run('b', 'ledger', 'waiting-approval')]);
    const b = teamPresence([run('a', 'forge', 'running'), run('b', 'ledger', 'waiting-approval')]);
    expect(a).not.toBe(b);
    expect(samePresence(a, b)).toBe(true);
    // The comparison is order-blind, because presence is not a sequence: the
    // same two teammates said the same two things.
    expect(samePresence(a, teamPresence([run('b', 'ledger', 'waiting-approval'), run('a', 'forge', 'running')]))).toBe(
      true,
    );
  });

  test('a Bot that changed state is not a match', () => {
    const working = teamPresence([run('a', 'forge', 'running')]);
    const needsYou = teamPresence([run('a', 'forge', 'waiting-approval')]);
    expect(samePresence(working, needsYou)).toBe(false);
    expect(samePresence(needsYou, working)).toBe(false);
  });

  test('a teammate gained or lost is not a match', () => {
    const one = teamPresence([run('a', 'forge', 'running')]);
    const two = teamPresence([run('a', 'forge', 'running'), run('b', 'ledger', 'running')]);
    expect(samePresence(one, two)).toBe(false);
    expect(samePresence(two, one)).toBe(false);
  });

  test('the same teammate under two names is two teammates', () => {
    // Same size, same states, different keys — a size-only check would pass this.
    const a = new Map([['forge', 'working' as const]]);
    const b = new Map([['ledger', 'working' as const]]);
    expect(samePresence(a, b)).toBe(false);
  });

  test('an empty map is not a map with anyone in it', () => {
    expect(samePresence(teamPresence([]), teamPresence([run('a', 'forge', 'running')]))).toBe(false);
    // A finished or unattributed run leaves no entry, so both say nothing.
    expect(samePresence(teamPresence([run('a', 'forge', 'complete')]), teamPresence([]))).toBe(true);
    expect(samePresence(teamPresence([run('a', undefined, 'running')]), teamPresence([]))).toBe(true);
  });
});