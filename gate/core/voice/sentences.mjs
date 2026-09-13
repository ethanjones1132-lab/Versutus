// ─── A Gate reply, cut into whole sentences ──────────────────────────────
// A JS port of `src/lib/voice/speech-chunks.ts`, so a reply the Gate speaks is
// cut the same way the phone's Phase 0 engine cuts it. Each chunk is a slice of
// the reply, in order, so the chunks joined back give the reply byte-for-byte.

const TERMINATORS = '.!?';

function isWhitespace(char) {
  return /\s/.test(char);
}

/** Where each sentence in a reply ends: the index just past one sentence. */
export function sentenceBoundaries(text) {
  const ends = [];
  let index = 0;

  while (index < text.length) {
    const char = text[index];
    let boundary = -1;

    if (TERMINATORS.includes(char)) {
      let last = index;
      while (last + 1 < text.length && TERMINATORS.includes(text[last + 1])) last += 1;
      const next = text[last + 1];
      if (next !== undefined && !isWhitespace(next)) {
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

/** The longest prefix of `text` that ends on a sentence boundary, or 0. */
export function completeSentenceLength(text) {
  const ends = sentenceBoundaries(text);
  return ends.length ? ends[ends.length - 1] : 0;
}

function sentencesOf(text) {
  const sentences = [];
  let start = 0;

  for (const end of sentenceBoundaries(text)) {
    sentences.push(text.slice(start, end));
    start = end;
  }

  if (start < text.length) sentences.push(text.slice(start));

  return sentences;
}

/** One reply as the ordered chunks it is spoken in. */
export function speechChunks(text, maxLength) {
  if (!(maxLength > 0)) return [];
  if (!text.trim()) return [];

  const chunks = [];
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
