import type { ChatMessage } from '@/lib/gateway/types';
import {
  completedSentenceText,
  handsfreeReplyForTurn,
  isFailedReply,
  planHandsfreeSpeech,
  replyPrefixIntact,
} from '@/lib/voice/handsfree-reply';

function message(partial: Partial<ChatMessage> & { id: string; role: ChatMessage['role'] }): ChatMessage {
  return { text: '', ...partial } as ChatMessage;
}

describe('handsfreeReplyForTurn', () => {
  const turn = message({ id: 'voice-call-1', role: 'user', text: 'hello' });

  test('finds the first assistant message after the call turn', () => {
    const reply = message({ id: 'run-1', role: 'assistant', text: 'hi' });
    expect(handsfreeReplyForTurn([turn, reply], 'voice-call-1')?.id).toBe('run-1');
  });

  test('an assistant message before the turn does not answer it', () => {
    const earlier = message({ id: 'run-0', role: 'assistant', text: 'old' });
    expect(handsfreeReplyForTurn([earlier, turn], 'voice-call-1')).toBeUndefined();
  });

  test('no reply yet, a missing turn id and an unknown id all answer undefined', () => {
    expect(handsfreeReplyForTurn([turn], 'voice-call-1')).toBeUndefined();
    expect(handsfreeReplyForTurn([turn], undefined)).toBeUndefined();
    expect(handsfreeReplyForTurn([turn], 'someone-else')).toBeUndefined();
  });

  test('skips a still-running command and a running tool card', () => {
    const running = message({
      id: 'cmd-1',
      role: 'assistant',
      text: 'Running x…',
      command: { status: 'running' },
    });
    const tool = message({
      id: 'run-1',
      role: 'assistant',
      text: '',
      toolCalls: [{ name: 'search', status: 'running' }],
    });
    const reply = message({ id: 'run-2', role: 'assistant', text: 'the answer' });
    expect(handsfreeReplyForTurn([turn, running, tool, reply], 'voice-call-1')?.id).toBe('run-2');
  });

  test('a completed tool card with text still answers the turn', () => {
    const reply = message({
      id: 'run-2',
      role: 'assistant',
      text: 'the answer',
      toolCalls: [{ name: 'search', status: 'complete' }],
    });
    expect(handsfreeReplyForTurn([turn, reply], 'voice-call-1')?.id).toBe('run-2');
  });
});

describe('isFailedReply', () => {
  test('an interrupted reply has failed', () => {
    expect(isFailedReply(message({ id: 'r', role: 'assistant', interrupted: true }))).toBe(true);
  });

  test('an error written onto the bubble has failed', () => {
    expect(isFailedReply(message({ id: 'r', role: 'assistant', text: 'Error: boom' }))).toBe(true);
  });

  test('a completed reply has not', () => {
    expect(isFailedReply(message({ id: 'r', role: 'assistant', text: 'all good' }))).toBe(false);
  });
});

describe('replyPrefixIntact', () => {
  test('an append-only reply keeps the spoken prefix', () => {
    expect(replyPrefixIntact('Hello. ', 'Hello. World.')).toBe(true);
  });

  test('a shrunk or reworded reply does not', () => {
    expect(replyPrefixIntact('Hello. World.', 'Hello.')).toBe(false);
    expect(replyPrefixIntact('Hello. ', 'Goodbye. ')).toBe(false);
  });
});

describe('completedSentenceText', () => {
  test('a sentence ending on a terminator is complete', () => {
    expect(completedSentenceText('Hello.')).toBe('Hello.');
    expect(completedSentenceText('Hello. Wor')).toBe('Hello. ');
  });

  test('a sentence with no terminator yet is not complete', () => {
    expect(completedSentenceText('Hello Wor')).toBe('');
  });

  test('a line break completes the line', () => {
    expect(completedSentenceText('first line\nsecond')).toBe('first line\n');
  });

  test('a terminator inside a number is not a boundary', () => {
    expect(completedSentenceText('pi is 3.14')).toBe('');
    expect(completedSentenceText('pi is 3.14. Next')).toBe('pi is 3.14. ');
  });
});

describe('planHandsfreeSpeech', () => {
  const base = { spoken: '', maxLength: 1000, waitForCompletion: false };

  test('a streaming reply is spoken only up to its last completed sentence', () => {
    const plan = planHandsfreeSpeech({ ...base, fullText: 'Hello. Wor', streaming: true });
    expect(plan.chunks).toEqual(['Hello. ']);
    expect(plan.spoken).toBe('Hello. ');
    expect(plan.mutated).toBe(false);
  });

  test('a completed reply is spoken in full, including a missing terminator', () => {
    const plan = planHandsfreeSpeech({ ...base, fullText: 'Hello. And more', streaming: false });
    expect(plan.chunks).toEqual(['Hello. And more']);
    expect(plan.spoken).toBe('Hello. And more');
  });

  test('already-spoken text is not spoken again as the reply grows', () => {
    const first = planHandsfreeSpeech({ ...base, fullText: 'One. Two. ', streaming: true });
    expect(first.chunks).toEqual(['One. Two. ']);
    const second = planHandsfreeSpeech({
      ...base,
      fullText: 'One. Two. Three.',
      streaming: true,
      spoken: first.spoken,
    });
    expect(second.chunks).toEqual(['Three.']);
    expect(second.spoken).toBe('One. Two. Three.');
  });

  test('the platform bound cuts long completed text into chunks', () => {
    const plan = planHandsfreeSpeech({
      ...base,
      fullText: 'One. Two. Three.',
      streaming: true,
      maxLength: 5,
    });
    expect(plan.chunks.length).toBeGreaterThan(1);
  });

  test('a reply that mutates where it was already spoken is reported, not spoken', () => {
    const plan = planHandsfreeSpeech({
      ...base,
      fullText: 'Goodbye. ',
      streaming: true,
      spoken: 'Hello. ',
    });
    expect(plan.mutated).toBe(true);
    expect(plan.chunks).toEqual([]);
  });

  test('a wait-for-completion turn says nothing while the reply is still streaming', () => {
    const plan = planHandsfreeSpeech({
      ...base,
      fullText: 'Hello. World. ',
      streaming: true,
      waitForCompletion: true,
    });
    expect(plan.chunks).toEqual([]);
  });

  test('the wait-for-completion turn speaks the rest once the reply finishes', () => {
    const plan = planHandsfreeSpeech({
      ...base,
      fullText: 'Hello. World.',
      streaming: false,
      waitForCompletion: true,
    });
    expect(plan.chunks).toEqual(['Hello. World.']);
  });

  test('a nothing-new update plans no chunks', () => {
    const plan = planHandsfreeSpeech({
      ...base,
      fullText: 'Hello. ',
      streaming: true,
      spoken: 'Hello. ',
    });
    expect(plan.chunks).toEqual([]);
    expect(plan.spoken).toBe('Hello. ');
  });
});
