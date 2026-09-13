import {
  councilSummaryCopy,
  councilTargets,
  runCouncil,
  type CouncilTarget,
} from '@/lib/gateway/council';

const ROSTER = [
  { id: 'scout', displayName: 'Scout' },
  { id: 'night', displayName: 'Night' },
  { id: ' scout ', displayName: 'dupe' },
  { id: 'ada', displayName: '' },
  { id: 'zed', displayName: 'Zed' },
  { id: 'extra', displayName: 'Extra' },
];

describe('council targets', () => {
  test('are trimmed, deduped and capped, keeping roster order', () => {
    const targets = councilTargets(ROSTER, 3);
    expect(targets).toEqual([
      { botId: 'scout', label: 'Scout' },
      { botId: 'night', label: 'Night' },
      { botId: 'ada', label: 'ada' },
    ]);
  });
});

describe('the council fan-out', () => {
  test('keeps target order and isolates one failure from the rest', async () => {
    const targets: CouncilTarget[] = [
      { botId: 'scout', label: 'Scout' },
      { botId: 'night', label: 'Night' },
      { botId: 'ada', label: 'ada' },
    ];
    const columns = await runCouncil('Compare notes.', targets, async (target) => {
      if (target.botId === 'night') throw new Error('offline');
      return `${target.label} says hi`;
    });

    expect(columns.map((column) => column.botId)).toEqual(['scout', 'night', 'ada']);
    expect(columns[0]).toEqual({ botId: 'scout', label: 'Scout', state: 'answered', text: 'Scout says hi' });
    expect(columns[1]).toEqual({ botId: 'night', label: 'Night', state: 'failed', error: 'offline' });
    expect(columns[2]).toEqual({ botId: 'ada', label: 'ada', state: 'answered', text: 'ada says hi' });
  });

  test('an empty answer is a failure, not a blank column, and the summary counts answers', async () => {
    const targets: CouncilTarget[] = [
      { botId: 'scout', label: 'Scout' },
      { botId: 'night', label: 'Night' },
    ];
    const columns = await runCouncil('hi', targets, async (target) =>
      target.botId === 'scout' ? '   ' : 'ok',
    );
    expect(columns[0].state).toBe('failed');
    expect(columns[1].state).toBe('answered');
    expect(councilSummaryCopy(columns)).toBe('1 of 2 answered.');
    const allAnswered = columns.map((column, index) => ({
      botId: column.botId,
      label: column.label,
      state: 'answered' as const,
      text: `answer ${index + 1}`,
    }));
    expect(councilSummaryCopy(allAnswered)).toBe('Both answered.');
  });
});
