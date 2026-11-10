import { filterRosterBots, rosterBackendFilters } from '@/lib/gateway/roster-filter';
import type { PublicBot, RosterRow } from '@/lib/gateway/bots';

const hermes: PublicBot = { id: 'scout', displayName: 'Scout', routable: true, runtime: 'hermes', backendId: 'hermes-main' };
const openCode: PublicBot = { id: 'builder', displayName: 'Builder', routable: true, runtime: 'opencode', backendId: 'oc-main' };

describe('roster backend filter helpers', () => {
  test('lists only tagged runtimes in picker order with display labels', () => {
    expect(rosterBackendFilters([openCode, hermes])).toEqual([
      { id: 'hermes', label: 'Hermes' },
      { id: 'opencode', label: 'OpenCode' },
    ]);
  });

  test('keeps unknown runtime labels alphabetical and omits untagged Bots', () => {
    expect(rosterBackendFilters([
      { ...hermes, runtime: undefined },
      { ...hermes, id: 'z', runtime: 'Zeta' },
      { ...hermes, id: 'a', runtime: 'Alpha' },
    ])).toEqual([{ id: 'alpha', label: 'Alpha' }, { id: 'zeta', label: 'Zeta' }]);
  });

  test('filters Bots only and preserves Direct chat', () => {
    const rows: RosterRow[] = [{ kind: 'configurable' }, { kind: 'bot', bot: hermes }, { kind: 'bot', bot: openCode }];
    expect(filterRosterBots(rows, 'opencode')).toEqual([rows[0], rows[2]]);
    expect(filterRosterBots(rows, null)).toBe(rows);
  });
});
