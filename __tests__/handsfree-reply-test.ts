import type { ChatMessage } from '@/lib/gateway/types';
import {
  completedSentenceText,
  handsfreeReplyForTurn,
  isFailedReply,
  planHandsfreeSpeech,
  replyPrefixIntact,
  type HandsfreeSpeechCursor,
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

  test('a finished tool-only bubble with no text is still the reply', () => {
    // The watchdog used to discharge on appearance and never re-arm, so this
    // empty row parked the call in Waiting. The correlator accepting it is the
    // input that path has to watch.
    const reply = message({
      id: 'run-2',
      role: 'assistant',
      text: '',
      command: { status: 'complete' },
    });
    expect(handsfreeReplyForTurn([turn, reply], 'voice-call-1')).toEqual(reply);
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

  test('a terminator that ends a streaming text is held rather than accepted', () => {
    // The dot of `Version 3.` is the same character as the dot of `3.14`, so a
    // text that may still grow cannot call it a sentence end: `3.` would be
    // spoken, and the `14 is out.` that followed would never correct it.
    expect(completedSentenceText('Version 3.', { streaming: true })).toBe('');
    expect(completedSentenceText('Version 3.14', { streaming: true })).toBe('');
    expect(completedSentenceText('Version 3.14 is out.', { streaming: true })).toBe('');
    // The held run is only the last one: the sentence before it stays complete.
    expect(completedSentenceText('Wait... is that right?', { streaming: true })).toBe('Wait... ');
    // A following whitespace resolves it, and the sentence is complete again.
    expect(completedSentenceText('Version 3.14 is out. ', { streaming: true })).toBe(
      'Version 3.14 is out. ',
    );
    expect(completedSentenceText('Hello. Wor', { streaming: true })).toBe('Hello. ');
    // A finished text keeps the old answer: the terminator closes the sentence.
    expect(completedSentenceText('Version 3.')).toBe('Version 3.');
    expect(completedSentenceText('Wait... is that right?')).toBe('Wait... is that right?');
  });

  test('a line break still ends a sentence at the end of a streaming text', () => {
    // A line break cannot be the inside of a number, so it is never held.
    expect(completedSentenceText('first line\n', { streaming: true })).toBe('first line\n');
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
      cursor: first.cursor,
    });
    // `Three.` ends the buffer while the reply may still grow, so its dot is
    // held rather than spoken early — it is delayed, never lost.
    expect(second.chunks).toEqual([]);
    expect(second.spoken).toBe('One. Two. ');
    const finished = planHandsfreeSpeech({
      ...base,
      fullText: 'One. Two. Three.',
      streaming: false,
      spoken: second.spoken,
      cursor: second.cursor,
    });
    expect(finished.chunks).toEqual(['Three.']);
    expect(finished.spoken).toBe('One. Two. Three.');
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

// The shipped defect: `Version 3.` arrived as its own delta, the scan called its
// dot a sentence end, and the synthesizer said "Version three" — then the next
// delta's "14 is out" was a second utterance, with the cursor already past the
// dot. The dot of `3.` and the dot of `3.14` are the same character, so neither
// path may spend it until something after it decides which one it is.
describe('planHandsfreeSpeech — a streaming terminator at the end of the buffer', () => {
  const base = { spoken: '', maxLength: 1000, waitForCompletion: false };
  const FULL = 'Version 3.14 is out.';

  test('without a cursor, "3." is not spoken and the finished reply is said once', () => {
    const early = planHandsfreeSpeech({ ...base, fullText: 'Version 3.', streaming: true });
    // The defect spoke `Version 3.` here.
    expect(early.chunks).toEqual([]);
    expect(early.spoken).toBe('');

    const later = planHandsfreeSpeech({
      ...base,
      fullText: 'Version 3.14 is out.',
      streaming: true,
      spoken: early.spoken,
    });
    // The dot is still inside a number, so it is not a boundary either.
    expect(later.chunks).toEqual([]);
    expect(later.spoken).toBe('');

    const finished = planHandsfreeSpeech({
      ...base,
      fullText: FULL,
      streaming: false,
      spoken: later.spoken,
    });
    expect(finished.chunks).toEqual([FULL]);
    expect(finished.spoken).toBe(FULL);
    // Nothing was said twice: one chunk carries the whole sentence.
    expect(finished.chunks.join('')).toBe(FULL);
  });

  test('with a cursor, every delta of "3.14" holds the dot and says it exactly once', () => {
    let spoken = '';
    let cursor: HandsfreeSpeechCursor | undefined;
    const said: string[] = [];
    for (let end = 1; end <= FULL.length; end += 1) {
      const fullText = FULL.slice(0, end);
      const streaming = end < FULL.length;
      const plan = planHandsfreeSpeech({
        ...base,
        fullText,
        streaming,
        spoken,
        cursor,
      });
      expect(plan.mutated).toBe(false);
      // The cursor read the whole delta even when it would not spend the dot,
      // so the next delta resumes after it instead of re-reading the reply.
      if (streaming) expect(plan.cursor?.index).toBe(fullText.length);
      said.push(...plan.chunks);
      spoken = plan.spoken;
      cursor = plan.cursor;
      // At no cut is `Version 3.` a spoken sentence, and `3.14` is never cut.
      for (const chunk of plan.chunks) expect(chunk).not.toBe('Version 3.');
      expect(plan.spoken === '' || FULL.startsWith(plan.spoken)).toBe(true);
    }
    expect(said.join('')).toBe(FULL);
    // One utterance, never a piece of one: `3.` was not said on its own.
    expect(said).toEqual([FULL]);
  });

  test('the held dot is spent as soon as the delta after it is whitespace', () => {
    const held = planHandsfreeSpeech({ ...base, fullText: 'Hello. Two.', streaming: true });
    // `Two.` ends the buffer, so its dot is held; `Hello. ` is not the buffer's
    // end and is spoken as usual.
    expect(held.chunks).toEqual(['Hello. ']);
    expect(held.spoken).toBe('Hello. ');
    const resolved = planHandsfreeSpeech({
      ...base,
      fullText: 'Hello. Two. Three.',
      streaming: true,
      spoken: held.spoken,
      cursor: held.cursor,
    });
    expect(resolved.chunks).toEqual(['Two. ']);
    expect(resolved.spoken).toBe('Hello. Two. ');
  });

  test('a held run is re-examined, so replaying the same delta says nothing twice', () => {
    const first = planHandsfreeSpeech({ ...base, fullText: 'Version 3.', streaming: true });
    const replay = planHandsfreeSpeech({
      ...base,
      fullText: 'Version 3.',
      streaming: true,
      spoken: first.spoken,
      cursor: first.cursor,
    });
    expect(replay.chunks).toEqual([]);
    expect(replay.spoken).toBe('');
    expect(replay.cursor).toEqual(first.cursor);
  });
});
