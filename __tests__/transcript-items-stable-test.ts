import { stableTranscriptItems, type TranscriptItem } from '@/lib/chat/transcript-items';
import type { ChatMessage } from '@/lib/gateway/types';

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(relative: string): string {
  return nodeFs.readFileSync([__dirname, '..', 'src', relative].join(SEP), 'utf8');
}

/** A fixed label formatter: a small clock the tests control. */
function labelsAt(now: string): (timestamp: number) => string {
  return (timestamp) => `${now}:${timestamp}`;
}

function message(id: string, timestamp?: number, text = `text ${id}`): ChatMessage {
  return { id, role: text.startsWith('reply') ? 'assistant' : 'user', text, timestamp };
}

const DAY = 86_400_000;

describe('the transcript row fold', () => {
  test('an empty transcript folds to an empty list', () => {
    expect(stableTranscriptItems([], labelsAt('today'))).toEqual([]);
  });

  test('a from-scratch fold keeps the day-divider rule: one per new day, at the first message of it', () => {
    const items = stableTranscriptItems(
      [message('a', DAY), message('b', DAY * 2), message('c', DAY * 3), message('d')],
      labelsAt('today'),
    );
    expect(items.map((item) => item.label)).toEqual([
      'today:86400000',
      'today:172800000',
      'today:259200000',
      undefined,
    ]);
    expect(items.map((item) => item.showDivider)).toEqual([true, true, true, false]);
  });
});

describe('a streamed append keeps untouched rows referentially stable', () => {
  test('appending one message reuses every earlier row object', () => {
    const first = [message('a', DAY), message('b', DAY)];
    const before = stableTranscriptItems(first, labelsAt('today'));

    const after = stableTranscriptItems([...first, message('c', DAY + 1)], labelsAt('today'), before);

    expect(after).toHaveLength(3);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after[2].message.id).toBe('c');
    // The grown row is the day's first, so its divider is new — but the two
    // untouched rows are the very objects `renderItem` saw last flush.
    expect(after[2].showDivider).toBe(true);
  });

  test('a bubble replaced mid-stream gets a new row while its neighbours keep theirs', () => {
    const messages = [message('a', DAY), message('b', DAY), message('c', DAY)];
    const before = stableTranscriptItems(messages, labelsAt('today'));

    // The streaming bubble is rewritten by the delta fold: same slot, new object.
    const streamed = { ...messages[1], text: 'reply streaming' };
    const after = stableTranscriptItems(
      [messages[0], streamed, messages[2]],
      labelsAt('today'),
      before,
    );

    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
    expect(after[1].message).toBe(streamed);
    expect(after[2]).toBe(before[2]);
  });

  test('reuse never keys off the preview text: two bubbles with the same words stay separate rows', () => {
    const messages = [message('a', DAY, 'same words'), message('b', DAY, 'same words')];
    const before = stableTranscriptItems(messages, labelsAt('today'));
    const after = stableTranscriptItems([...messages, message('c', DAY, 'same words')], labelsAt('today'), before);

    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after[0]).not.toBe(after[1]);
    expect(after[2]).not.toBe(after[0]);
    expect(after.map((item) => item.message.id)).toEqual(['a', 'b', 'c']);
  });

  test('a carried row keeps its old label when the day it belongs to changes', () => {
    // The cached formatter rolls `Today` over to `Yesterday`; the same message
    // object must not carry the stale copy of the label with it.
    const messages = [message('a', DAY), message('b', DAY + 1)];
    const before = stableTranscriptItems(messages, labelsAt('today'));
    const after = stableTranscriptItems(messages, labelsAt('yesterday'), before);

    expect(after[0]).not.toBe(before[0]);
    expect(after[0].label).toBe('yesterday:86400000');
    expect(after[0].showDivider).toBe(true);
  });
});

describe('the carried rows agree with a from-scratch rebuild', () => {
  test('three streamed flushes produce the same rows as folding the final list alone', () => {
    const dayOne = [message('a', DAY), message('b', DAY)];
    const first = stableTranscriptItems(dayOne, labelsAt('today'));

    const second = stableTranscriptItems(
      [...dayOne, message('c', DAY + 1)],
      labelsAt('today'),
      first,
    );
    const thirdMessages = [...dayOne, { ...second[2].message, text: 'reply c' }];
    const third = stableTranscriptItems(thirdMessages, labelsAt('today'), second);

    const scratch: TranscriptItem[] = stableTranscriptItems(thirdMessages, labelsAt('today'));

    expect(third.map((item) => item.message.id)).toEqual(scratch.map((item) => item.message.id));
    expect(third.map((item) => item.label)).toEqual(scratch.map((item) => item.label));
    expect(third.map((item) => item.showDivider)).toEqual(scratch.map((item) => item.showDivider));
    // And the rebuild touched only the row whose message changed.
    expect(third[0]).toBe(first[0]);
    expect(third[1]).toBe(first[1]);
    expect(third[2]).not.toBe(second[2]);
  });

  test('a previous list from another transcript is not carried across', () => {
    const before = stableTranscriptItems([message('x', DAY)], labelsAt('today'));
    const after = stableTranscriptItems([message('a', DAY)], labelsAt('today'), before);

    expect(after).toHaveLength(1);
    expect(after[0].message.id).toBe('a');
    expect(after[0]).not.toBe(before[0]);
  });
});

describe('chat-screen wires the fold through the pure helper', () => {
  test('the transcriptItems memo hands the helper the previous fold and the divider formatter', () => {
    const screen = readSource('components/chat/chat-screen.tsx');
    expect(screen).toMatch(/stableTranscriptItems\(transcriptMessages, formatDayDividerCached, transcriptItemsRef\.current\)/);
    // The carried list is mirrored the way `messagesRef` mirrors the messages.
    expect(screen).toMatch(/transcriptItemsRef\.current = transcriptItems;/);
    expect(screen).toMatch(/data=\{transcriptItems\}/);
  });
});
