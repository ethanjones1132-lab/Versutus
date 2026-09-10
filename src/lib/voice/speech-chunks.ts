// ─── A spoken reply, cut into whole sentences ─────────────────────────────
// Solution B2 (`FUTURE-ITEMS.md:431-435`): with the speaker on, a long reply
// is "chunked at sentence boundaries (respect `Speech.maxSpeechInputLength`;
// unbounded on iOS, finite on Android) and queued in order", and B6 names the
// Jest case this file is (`:477`).
//
// Cutting is the only thing this file does, and it is pure: the bound is a
// parameter, so the platform's own answer is the caller's to hand in rather
// than a second guess at it here. The SDK 57 docs state that answer's contract
// — `Speech.maxSpeechInputLength` is "the maximum possible text length
// acceptable by `Speech.speak()`", platform dependent, and `Number.MAX_VALUE`
// on iOS — which is why a bound nothing can be spoken under is no speech at
// all rather than one enormous mouthful, and why a chunk is never longer than
// the bound unless a single sentence alone already is.
//
// Every chunk is a slice of the reply, in order, so the chunks joined back
// give the reply byte-for-byte: the boundaries decide where the queue pauses,
// never what is said. This file speaks nothing, sends nothing and imports
// nothing — the `expo-speech` seam is the caller under it.

/** The punctuation a sentence can end on. */
const TERMINATORS = '.!?';

/** Whether one character is whitespace, which a boundary takes with it. */
function isWhitespace(char: string): boolean {
  return /\s/.test(char);
}

/**
 * Where each sentence in a reply ends: the index just past one sentence, which
 * is where the next one begins. Two things end a sentence — a run of `.`, `!`
 * or `?` followed by whitespace or the end of the text, and a line break — and
 * the whitespace that follows either one belongs to the sentence that just
 * ended, so nothing is left stranded between two chunks and nothing is trimmed
 * off one.
 *
 * A terminator with something else on its far side is inside that thing rather
 * than the end of it (`3.14`, `v1.2.0`), so it is left alone. An abbreviation
 * that does trail a space (`e.g. `) reads as a boundary, which costs one pause
 * in the queue and moves no character — the alternative would be a list of
 * abbreviations to second-guess the reply with.
 */
function sentenceEnds(text: string): number[] {
  const ends: number[] = [];
  let index = 0;

  while (index < text.length) {
    const char = text[index];
    let boundary = -1;

    if (TERMINATORS.includes(char)) {
      let last = index;
      while (last + 1 < text.length && TERMINATORS.includes(text[last + 1])) last += 1;
      const next = text[last + 1];
      if (next !== undefined && !isWhitespace(next)) {
        // Inside something rather than the end of it.
        index = last + 1;
        continue;
      }
      boundary = last + 1;
    } else if (char === '\n') {
      boundary = index + 1;
    }

    if (boundary < 0) {
      index += 1;
      continue;
    }

    while (boundary < text.length && isWhitespace(text[boundary])) boundary += 1;
    ends.push(boundary);
    index = boundary;
  }

  return ends;
}

/** The reply's own sentences, in order, as slices that rejoin byte-for-byte. */
function sentencesOf(text: string): string[] {
  const sentences: string[] = [];
  let start = 0;

  for (const end of sentenceEnds(text)) {
    sentences.push(text.slice(start, end));
    start = end;
  }

  if (start < text.length) sentences.push(text.slice(start));

  return sentences;
}

/**
 * One reply as the ordered chunks it is spoken in: whole sentences, in the
 * order they were written, with as many of them to a chunk as the bound
 * allows. A sentence that alone exceeds `maxLength` is a chunk of its own
 * rather than cut in two — a platform handed less than the reply said would
 * speak something the Bot did not write.
 *
 * A bound that is not a positive number (`0`, a negative, `NaN`) answers no
 * chunks: nothing can be spoken under it, and one huge mouthful is not an
 * answer. `Infinity` and the iOS `Number.MAX_VALUE` are positive bounds, so a
 * reply they can hold is answered as a single chunk. A reply carrying no words
 * is no chunks either — there is nothing to say.
 */
export function speechChunks(text: string, maxLength: number): string[] {
  if (!(maxLength > 0)) return [];
  if (!text.trim()) return [];

  const chunks: string[] = [];
  let pending = '';

  for (const sentence of sentencesOf(text)) {
    if (pending && sentence.length > maxLength - pending.length) {
      chunks.push(pending);
      pending = '';
    }
    pending += sentence;
  }

  if (pending) chunks.push(pending);

  return chunks;
}
