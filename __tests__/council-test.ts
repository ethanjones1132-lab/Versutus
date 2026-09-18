import {
  councilPromptIssue,
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

  test('a blank answer is quiet, not a failure, and the summary counts answers', async () => {
    const targets: CouncilTarget[] = [
      { botId: 'scout', label: 'Scout' },
      { botId: 'night', label: 'Night' },
    ];
    const columns = await runCouncil('hi', targets, async (target) =>
      target.botId === 'scout' ? '   ' : 'ok',
    );
    expect(columns[0]).toEqual({ botId: 'scout', label: 'Scout', state: 'silent' });
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

  test('one failure and one silence leave the answering Bot in its column', async () => {
    const targets: CouncilTarget[] = [
      { botId: 'scout', label: 'Scout' },
      { botId: 'night', label: 'Night' },
      { botId: 'ada', label: 'ada' },
    ];
    const columns = await runCouncil('Compare notes.', targets, async (target) => {
      if (target.botId === 'night') throw new Error('offline');
      if (target.botId === 'ada') return '';
      return `${target.label} says hi`;
    });

    expect(columns.map((column) => column.botId)).toEqual(['scout', 'night', 'ada']);
    expect(columns[0]).toEqual({ botId: 'scout', label: 'Scout', state: 'answered', text: 'Scout says hi' });
    expect(columns[1]).toEqual({ botId: 'night', label: 'Night', state: 'failed', error: 'offline' });
    expect(columns[2]).toEqual({ botId: 'ada', label: 'ada', state: 'silent' });
    expect(councilSummaryCopy(columns)).toBe('1 of 3 answered.');
  });
});

describe('a council prompt is never a command', () => {
  test('a slash-leading prompt is refused before any leg is sent', () => {
    expect(councilPromptIssue('/run build the thing')).toBe(
      'The council sends one prompt, not a command — drop the leading slash.',
    );
    expect(councilPromptIssue('compare these drafts')).toBeUndefined();
    expect(councilPromptIssue('   ')).toBeUndefined();
  });
});
