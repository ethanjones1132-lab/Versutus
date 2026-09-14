import { EMPTY_GROUPS, applyGroupRead, planGroupRounds, describeGroupPlan } from '@/lib/gateway/groups';
import { foldCouncilResults, planCouncil, type CouncilBot, type CouncilReply } from '@/lib/gateway/council';

const ALICE: CouncilBot = { id: 'bot_alice', displayName: 'Alice' };
const BOB: CouncilBot = { id: 'bot_bob', displayName: 'Bob' };
const CAROL: CouncilBot = { id: 'bot_carol', displayName: 'Carol' };

describe('planCouncil', () => {
  it('plans one send per Bot in roster order', () => {
    expect(planCouncil([ALICE, BOB, CAROL], 'compare these drafts')).toEqual([
      { botId: 'bot_alice', text: 'compare these drafts' },
      { botId: 'bot_bob', text: 'compare these drafts' },
      { botId: 'bot_carol', text: 'compare these drafts' },
    ]);
  });

  it('counts the Bots it plans to ask', () => {
    expect(planCouncil([ALICE, BOB], 'go').length).toBe(2);
  });

  it('plans nothing for an empty council rather than sending a Botless prompt', () => {
    expect(planCouncil([], 'any prompt')).toEqual([]);
  });

  it('keeps the roster order of the caller — the fold never reorders it', () => {
    const roster = [CAROL, ALICE, BOB];
    expect(planCouncil(roster, 'p').map((step) => step.botId)).toEqual(['bot_carol', 'bot_alice', 'bot_bob']);
  });

  it('dedupes duplicate Bot ids to one send — no Bot is asked twice', () => {
    expect(planCouncil([ALICE, ALICE, BOB], 'p')).toEqual([
      { botId: 'bot_alice', text: 'p' },
      { botId: 'bot_bob', text: 'p' },
    ]);
  });

  it('never mentions anything — one prompt to several Bots is not a @mention send', () => {
    for (const step of planCouncil([ALICE, BOB], 'hello @bot_bob')) {
      expect(step).not.toHaveProperty('mentionedIds');
    }
  });
});

describe('foldCouncilResults', () => {
  const REPLIES: CouncilReply[] = [
    { botId: 'bot_carol', text: 'c', ok: true },
    { botId: 'bot_alice', text: 'a', ok: true },
  ];
  const ERRORS: CouncilReply[] = [
    { botId: 'bot_bob', text: '', ok: false, error: 'no listen key' },
  ];

  it('keys replies by Bot, keeping roster order — not reply arrival order', () => {
    const folded = foldCouncilResults({ roster: [ALICE, BOB, CAROL], replies: REPLIES, errors: ERRORS });
    expect(folded.map((entry) => entry.bot.id)).toEqual(['bot_alice', 'bot_bob', 'bot_carol']);
  });

  it('carries one reply slot per planned Bot — never fabricates one', () => {
    const folded = foldCouncilResults({ roster: [ALICE, BOB], replies: [], errors: [] });
    expect(folded).toHaveLength(2);
    for (const entry of folded) {
      expect(entry.reply).toBeUndefined();
      expect(entry.error).toBeUndefined();
    }
  });

  it('attaches a reply only to the Bot that spoke', () => {
    const folded = foldCouncilResults({ roster: [ALICE, BOB], replies: REPLIES, errors: [] });
    expect(folded[0].reply?.text).toBe('a');
    expect(folded[0].error).toBeUndefined();
    expect(folded[1].reply).toBeUndefined();
  });

  it('attaches a failure line where it happened, not as fabricated text', () => {
    const folded = foldCouncilResults({ roster: [ALICE, BOB], replies: [], errors: ERRORS });
    expect(folded[0].reply).toBeUndefined();
    expect(folded[1].error).toBe('no listen key');
  });

  it('does not let a corrupt reply invent a Bot the roster never had', () => {
    const folded = foldCouncilResults({
      roster: [ALICE],
      replies: [{ botId: 'bot_ghost', text: 'hi', ok: true }],
      errors: [],
    });
    expect(folded).toHaveLength(1);
    expect(folded[0].bot.id).toBe('bot_alice');
    expect(folded[0].reply).toBeUndefined();
  });

  it('adds no send: it folds, and does not grow the plan', () => {
    const plan = planCouncil([ALICE, BOB, CAROL], 'p');
    const folded = foldCouncilResults({ roster: [ALICE, BOB, CAROL], replies: REPLIES, errors: ERRORS });
    expect(plan.length).toBe(3);
    expect(folded.length).toBe(3);
  });
});

describe('boundaries the item pins', () => {
  it('group rooms are untouched — the ruler test on groups.ts still holds', () => {
    // applyGroupRead must still work byte-identically; council does not own it.
    expect(applyGroupRead(EMPTY_GROUPS, { ok: true, rooms: [] }).loaded).toBe(true);
  });

  it('how many bots speak is still the plan line, not a council count', () => {
    expect(describeGroupPlan(3)).toBe('3 bots speak · one round');
  });

  it('the group round planner is untouched — council does not re-plan it', () => {
    expect(planGroupRounds({ memberIds: ['a', 'b'], mentionedIds: [] })).toEqual([
      { botId: 'a' },
      { botId: 'b' },
    ]);
  });
});
