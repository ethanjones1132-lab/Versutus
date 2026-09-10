// Solution B2's sentence chunking (`FUTURE-ITEMS.md:431-435`): with the speaker
// on, a long reply is "chunked at sentence boundaries (respect
// `Speech.maxSpeechInputLength`; unbounded on iOS, finite on Android) and
// queued in order", and B6 lists this case (`:477`).
//
// The rules this suite pins: a chunk is never longer than the bound unless a
// single sentence alone already is, nothing is cut mid-sentence to reach a
// bound, and the chunks joined back give the reply byte-for-byte — the
// boundaries decide where the queue pauses, never what is said. A bound
// nothing could be spoken under answers no chunks at all.

import { speechChunks } from '@/lib/voice/speech-chunks';

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

describe('a reply is spoken as whole sentences', () => {
  const SENTENCES = 'Alpha one. Bravo two. Charlie three. Delta four.';
  /** The longest sentence in `SENTENCES`, counted by hand. */
  const LONGEST_SENTENCE = 'Charlie three. '.length;

  test('a reply inside the bound is one chunk', () => {
    expect(speechChunks(SENTENCES, 1000)).toEqual([SENTENCES]);
  });

  test('sentences are drawn together up to the bound, in order', () => {
    expect(speechChunks(SENTENCES, 22)).toEqual([
      'Alpha one. Bravo two. ',
      'Charlie three. ',
      'Delta four.',
    ]);
  });

  test('every sentence is its own chunk once none of them fit together', () => {
    expect(speechChunks(SENTENCES, LONGEST_SENTENCE)).toEqual([
      'Alpha one. ',
      'Bravo two. ',
      'Charlie three. ',
      'Delta four.',
    ]);
  });

  test('no chunk is over the bound unless one sentence alone is, at every bound', () => {
    for (let bound = 1; bound <= SENTENCES.length; bound += 1) {
      const chunks = speechChunks(SENTENCES, bound);
      expect(chunks.join('')).toBe(SENTENCES);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(Math.max(bound, LONGEST_SENTENCE));
      }
    }
  });

  test('a sentence longer than the whole bound is spoken whole rather than cut', () => {
    // Cutting it would hand the platform less than the Bot wrote: one pause
    // too few is the smaller wrong.
    const sentence = 'This sentence is longer than the whole bound.';
    const reply = `Yes. ${sentence}`;

    expect(speechChunks(reply, 10)).toEqual(['Yes. ', sentence]);
    expect(sentence.length).toBeGreaterThan(10);
  });

  test('a line break ends a sentence even without punctuation', () => {
    expect(speechChunks('Line one\nLine two.', 9)).toEqual(['Line one\n', 'Line two.']);
  });

  test('a run of terminators is one boundary', () => {
    expect(speechChunks('Really?! Yes.', 9)).toEqual(['Really?! ', 'Yes.']);
  });

  test('a full stop inside a number is not a boundary', () => {
    expect(speechChunks('Pi is 3.14 today.', 100)).toEqual(['Pi is 3.14 today.']);
  });

  test('every character of the reply comes back, however it is cut', () => {
    const reply =
      'Here are three numbers:\n\n1. 3.14 is pi.\n2. e is 2.71828.\n3. "Done!" he said.\n\nAnything else?';

    for (const bound of [1, 5, 12, 40, 1000, Number.MAX_VALUE, Infinity]) {
      expect(speechChunks(reply, bound).join('')).toBe(reply);
    }
  });
});

describe('a bound nothing can be spoken under is no speech at all', () => {
  test('zero, a negative and NaN answer no chunks', () => {
    expect(speechChunks('One. Two.', 0)).toEqual([]);
    expect(speechChunks('One. Two.', -1)).toEqual([]);
    expect(speechChunks('One. Two.', Number.NaN)).toEqual([]);
  });

  test('Infinity, and the unbounded answer iOS reports, answer the reply as one chunk', () => {
    // The SDK 57 docs: `Speech.maxSpeechInputLength` is "platform dependent",
    // `Number.MAX_VALUE` on iOS — a bound, not an absence of one.
    expect(speechChunks('One. Two.', Infinity)).toEqual(['One. Two.']);
    expect(speechChunks('One. Two.', Number.MAX_VALUE)).toEqual(['One. Two.']);
  });

  test('a reply carrying no words answers no chunks', () => {
    // There is nothing to say, so there is nothing to queue — the same rule
    // the spoken draft's fold keeps for a transcript with no words in it.
    expect(speechChunks('', 100)).toEqual([]);
    expect(speechChunks('   \n  ', 100)).toEqual([]);
  });
});

describe('cutting a reply speaks nothing', () => {
  const source = () => readSource('src', 'lib', 'voice', 'speech-chunks.ts');

  test('the module imports nothing at all — no speech engine, no gateway, no storage', () => {
    // The strongest form of the must-still: a file with no import statements
    // at all cannot name expo-speech, reach a gateway, or open storage.
    const src = source();
    expect(src.match(/^import .*$/gm) ?? []).toHaveLength(0);
    expect(src).not.toContain('fetch(');
  });
});
