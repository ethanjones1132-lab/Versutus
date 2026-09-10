// Solution B2's rule for what the speaker owes (FUTURE-ITEMS.md `:431-435`):
// "each completed assistant message is spoken", and "a new user message or
// toggle-off calls `Speech.stop()`". The screen watches the transcript's tail
// and asks this fold, so the rule is pinned here against the transcripts the
// screen can actually hold — a reply still streaming, one the connection
// interrupted, a command still producing output — rather than only inside a
// screen this suite cannot mount.

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(...parts: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

import { speakerAction } from '@/lib/voice/speech-reply';
import type { ChatMessage } from '@/lib/gateway/types';

const message = (fields: Partial<ChatMessage> & Pick<ChatMessage, 'role'>): ChatMessage => ({
  id: 'm1',
  text: 'Hello.',
  ...fields,
});

describe('what the speaker does about the transcript', () => {
  test('a transcript with nothing in it is nothing to do', () => {
    expect(speakerAction(undefined)).toEqual({ kind: 'nothing' });
  });

  test('a finished reply is read, in the Bot’s own words', () => {
    // Verbatim: the seam hands the reply to the platform as it was written, and
    // the folding of it is `speechChunks`'s job, not this rule's.
    expect(speakerAction(message({ role: 'assistant', text: 'Two things:\n1. One.\n2. Two.' }))).toEqual({
      kind: 'speak',
      text: 'Two things:\n1. One.\n2. Two.',
    });
  });

  test('a reply still streaming is not read', () => {
    // Half a sentence is not the Bot answering; the tail is read once the
    // bubble stops streaming.
    expect(
      speakerAction(message({ role: 'assistant', text: 'Half a sen', streaming: true })),
    ).toEqual({ kind: 'nothing' });
  });

  test('a reply the connection interrupted is not read', () => {
    // The stream dropped mid-sentence: speaking what arrived would tell the
    // operator the Bot finished saying something it did not.
    expect(
      speakerAction(message({ role: 'assistant', text: 'Half a sen', interrupted: true })),
    ).toEqual({ kind: 'nothing' });
  });

  test('a command still producing output is not read', () => {
    expect(
      speakerAction(
        message({
          role: 'assistant',
          text: 'Waiting for your approval…',
          command: { input: '/run', title: 'Run', status: 'running' },
        }),
      ),
    ).toEqual({ kind: 'nothing' });
  });

  test('a command that has finished is a completed message like any other', () => {
    expect(
      speakerAction(
        message({ role: 'assistant', text: 'All clear.', command: { input: '/status', title: 'Status', status: 'complete' } }),
      ),
    ).toEqual({ kind: 'speak', text: 'All clear.' });
  });

  test('a message carrying no words is not read', () => {
    expect(speakerAction(message({ role: 'assistant', text: '   \n ' }))).toEqual({ kind: 'nothing' });
  });

  test('a system line is not the Bot answering', () => {
    expect(speakerAction(message({ role: 'system', text: 'Connected.' }))).toEqual({ kind: 'nothing' });
  });

  test('a user turn silences whatever is being read', () => {
    // The turn ends the reply, whether or not anything is still playing; the
    // screen decides whether this conversation is speaking at all.
    expect(speakerAction(message({ role: 'user', text: 'And another thing.' }))).toEqual({
      kind: 'silence',
    });
  });
});

describe('the rule itself', () => {
  test('it is pure: a type is all it imports', () => {
    const source = readSource('src', 'lib', 'voice', 'speech-reply.ts');

    // No engine, no gateway, no storage: the screen is the only thing that
    // acts on this answer.
    expect(source.match(/^import .*$/gm) ?? []).toEqual([
      "import type { ChatMessage } from '@/lib/gateway/types';",
    ]);
    expect(source).not.toContain('fetch(');
  });
});
