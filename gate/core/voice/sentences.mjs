// ─── A Gate reply, cut into whole sentences ──────────────────────────────
// A JS port of `src/lib/voice/speech-chunks.ts`, so a reply the Gate speaks is
// cut the same way the phone's Phase 0 engine cuts it. Each chunk is a slice of
// the reply, in order, so the chunks joined back give the reply byte-for-byte.
//
// A fenced code block is never a cut point. The worker cleans every `speak`
// chunk it is given, and its fence rule needs the whole block in one piece: cut
// at a line inside the fence and the code's own words leak out as speech (U6).

const TERMINATORS = '.!?';

// A run of three backticks on its own line opens a fence, at any indent: the
// worker's cleaner treats any ``` run as one, so the splitter must too, or an
// indented block would be cut and its body read out. The info string cannot
// itself contain a backtick, which keeps inline ``a `b` c`` out of this.
const FENCE_OPEN = /^[ \t]*(`{3,})([^`]*)$/;
const FENCE_CLOSE = /^[ \t]*(`{3,})\s*$/;

function isWhitespace(char) {
  return /\s/.test(char);
}

/**
 * Which characters sit inside a fenced code block, newline included. Only the
 * fence's own characters are marked: prose keeps every sentence boundary it had,
 * so the sentence after a closed fence is spoken exactly as it would be alone.
 * A fence line is marked through its newline so no cut lands inside the block,
 * but a closing fence stops at its last backtick, leaving the newline after it
 * as the one boundary the block ends on.
 */
function insideFenceMask(text) {
  const mask = new Uint8Array(text.length + 1);
  let fence = null;
  let start = 0;

  while (start < text.length) {
    const newline = text.indexOf('\n', start);
    const end = newline === -1 ? text.length : newline;
    const line = text.slice(start, end);
    let markTo = end;

    if (fence) {
      const close = FENCE_CLOSE.exec(line);
      if (close && close[1].length >= fence.length) fence = null;
      else if (newline !== -1) markTo = newline + 1;
    } else {
      const open = FENCE_OPEN.exec(line);
      if (open) {
        fence = open[1];
        if (newline !== -1) markTo = newline + 1;
      } else {
        // An ordinary line: mask nothing, or its periods and ends would stop
        // being cut points and the prose after a fence would never be released.
        markTo = start;
      }
    }

    for (let index = start; index < markTo; index += 1) mask[index] = 1;
    if (newline === -1) break;
    start = newline + 1;
  }

  return mask;
}

/** Where each sentence in a reply ends: the index just past one sentence. */
export function sentenceBoundaries(text) {
  const ends = [];
  const fenced = insideFenceMask(text);
  let index = 0;

  while (index < text.length) {
    const char = text[index];
    let boundary = -1;

    if (!fenced[index] && TERMINATORS.includes(char)) {
      let last = index;
      while (last + 1 < text.length && TERMINATORS.includes(text[last + 1])) last += 1;
      const next = text[last + 1];
      if (next !== undefined && !isWhitespace(next)) {
        index = last + 1;
        continue;
      }
      boundary = last + 1;
    } else if (!fenced[index] && char === '\n') {
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
