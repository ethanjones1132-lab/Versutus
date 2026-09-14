import { describe, expect, it } from '@jest/globals';
import {
  COUNCIL_MIN_BOTS,
  COUNCIL_DESTINATION_COPY,
  botResultLine,
  councilEntryCopy,
  councilProgressCopy,
  councilPromptCopy,
  councilPromptIssue,
  councilScopeCopy,
  councilSendCopy,
  latestReplyText,
} from '@/lib/gateway/council-view';
import type { ChatMessage } from '@/lib/gateway/types';
import type { CouncilResultSlot } from '@/lib/gateway/council';

function slot(botId: string, patch?: Partial<Omit<CouncilResultSlot, 'bot'>>): CouncilResultSlot {
  return {
    bot: { id: botId, displayName: botId.replace('bot_', '') },
    ...patch,
  };
}

describe('council view folds (D7 slice 1)', () => {
  it('the roster row invites the comparison and gates on nothing the surface cannot do', () => {
    expect(councilEntryCopy()).toEqual({
      title: 'Council',
      subtitle: 'Ask 2+ Bots the same prompt, answers side by side',
    });
  });

  it('a council is at least two Bots — one picked Bot is an invitation, not a send', () => {
    expect(COUNCIL_MIN_BOTS).toBe(2);
    expect(councilSendCopy({ pickedCount: 1, hasPrompt: true, busy: false }).enabled).toBe(false);
    expect(councilSendCopy({ pickedCount: 2, hasPrompt: true, busy: false }).enabled).toBe(true);
    expect(councilSendCopy({ pickedCount: 2, hasPrompt: false, busy: false }).enabled).toBe(false);
    expect(councilSendCopy({ pickedCount: 2, hasPrompt: true, busy: true }).enabled).toBe(false);
  });

  it('the send button never lies about what it is doing', () => {
    expect(councilSendCopy({ pickedCount: 2, hasPrompt: true, busy: true }).label).toBe('Asking…');
    expect(councilSendCopy({ pickedCount: 2, hasPrompt: true, busy: false }).label).toBe('Send to council');
  });

  it('the progress line counts settled legs without promising a total time', () => {
    expect(councilProgressCopy(0, 3)).toBe('Asking 3 Bots… no answers yet');
    expect(councilProgressCopy(1, 3)).toBe('Asking 3 Bots… 1 answer in');
    expect(councilProgressCopy(3, 3)).toBe('Asking 3 Bots… 3 answers in');
  });

  it('the composer copy names the same prompt every Bot receives', () => {
    expect(councilPromptCopy()).toBe('One prompt, every picked Bot. Answers stay in each Bot Chat.');
  });

  it('the scope line states the picked count against the roster, honestly when idle', () => {
    expect(councilScopeCopy({ pickedCount: 2, routableCount: 4, busy: false })).toBe('2 of 4 Bots picked');
    expect(councilScopeCopy({ pickedCount: 3, routableCount: 5, busy: true })).toBe('3 of 5 Bots picked');
  });

  it('an unfilled slot says a reply is still owed, never a fabricated one', () => {
    expect(botResultLine(slot('bot_alice'), false)).toBe('No answer yet.');
    expect(botResultLine(slot('bot_alice'), true)).toBe('Asking…');
  });

  it('a failed leg renders the humanized cause through the same slot, never as text', () => {
    expect(botResultLine(slot('bot_alice', { error: 'no listen key' }), false)).toBe('Failed: no listen key');
    expect(
      // An error outranks a stale reply bubble — the row says the leg failed.
      botResultLine(slot('bot_alice', { reply: { text: 'hi' }, error: 'timed out' }), false),
    ).toBe('Failed: timed out');
  });

  it('the destination copy is a promise about where answers live, in both directions', () => {
    expect(COUNCIL_DESTINATION_COPY).toBe(
      'Answers are sent to their own Bot Chat — open one to keep the thread going.',
    );
  });

  it("the reply capture takes the leg's own answer after its prompt", () => {
    const earlier: ChatMessage[] = [
      { id: 'u1', role: 'user', text: 'older turn', timestamp: 1 },
      { id: 'a1', role: 'assistant', text: 'PRE-PROMPT', timestamp: 2 },
      { id: 'u2', role: 'user', text: 'the council prompt', timestamp: 3 },
    ];
    // Everything before the leg's own prompt is not this leg's answer.
    expect(latestReplyText(earlier, 'the council prompt')).toBeUndefined();
    expect(
      latestReplyText(
        [...earlier, { id: 'a2', role: 'assistant', text: 'THE ANSWER', timestamp: 5 }],
        'the council prompt',
      ),
    ).toBe('THE ANSWER');
    // Command machinery (ephemeral or not) is never an answer, and a
    // streaming row is not final — the capture keeps waiting.
    expect(
      latestReplyText(
        [
          ...earlier,
          { id: 'c1', role: 'assistant', text: 'Running…', timestamp: 4, command: { input: '/x', title: '/x', status: 'running', ephemeral: true } },
          { id: 'a3', role: 'assistant', text: '', timestamp: 5, streaming: true },
        ],
        'the council prompt',
      ),
    ).toBeUndefined();
  });
  it('a slash-leading prompt is refused before any leg is sent', () => {
    expect(councilPromptIssue('/run build the thing')).toBe(
      'The council sends one prompt, not a command — drop the leading slash.',
    );
    expect(councilPromptIssue('compare these drafts')).toBeUndefined();
    expect(councilPromptIssue('   ')).toBeUndefined();
  });
});
