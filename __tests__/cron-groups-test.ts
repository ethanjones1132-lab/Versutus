import {
  groupCronJobsByOwner,
  type CronJob,
} from '@/lib/gateway/cron';

const job = (over: Partial<CronJob>, id: string): CronJob => ({ id, title: 'Job', ...over });

test('a job whose name carries a Bot is grouped under that Bot only', () => {
  const groups = groupCronJobsByOwner([
    job({ name: '[bot:mail] Overnight digest' }, 'a'),
    job({ name: '[bot:mail] Morning digest' }, 'b'),
    job({ name: '[bot:pulse] Pulse check' }, 'c'),
  ]);
  expect(groups.size).toBe(2);
  expect(groups.get('mail')?.map((j) => j.id)).toEqual(['a', 'b']);
  expect(groups.get('pulse')?.map((j) => j.id)).toEqual(['c']);
});

test('unowned jobs share one gateway group, never guessed into a Bot', () => {
  // The same rule scorecardRoutineHealth applies to a job with no `[bot:]` name.
  const groups = groupCronJobsByOwner([
    job({}, 'g1'),
    job({ name: '[bot:mail] Digest' }, 'm1'),
    job({ name: 'no-prefix name' }, 'g2'),
  ]);
  expect([...groups.keys()]).toEqual([null, 'mail']);
  expect(groups.get(null)?.map((j) => j.id)).toEqual(['g1', 'g2']);
});

test('group order follows input order, and grouped jobs keep their list order', () => {
  const groups = groupCronJobsByOwner([
    job({ name: '[bot:b] One' }, 'b1'),
    job({}, 'g1'),
    job({ name: '[bot:a] Two' }, 'a1'),
  ]);
  expect([...groups.keys()]).toEqual(['b', null, 'a']);
  expect(groups.get('a')?.[0].id).toBe('a1');
});

test('a Bot id the scorecards would refuse is unowned, not an empty-string group', () => {
  // scorecardBotId's rule: an id is an id only when present and non-empty.
  const groups = groupCronJobsByOwner([job({ name: '[bot:] Bare prefix' }, 'bare')]);
  expect([...groups.keys()]).toEqual([null]);
});
