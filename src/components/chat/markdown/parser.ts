/**
 * Minimal, dependency-free markdown parser tuned for agent chat output.
 * Supports: fenced code blocks, headings (1-4), blockquotes, ordered/unordered
 * lists, horizontal rules, paragraphs, and inline bold / italic / code /
 * strikethrough / links. Bold spans may contain nested inline styles.
 */

export type MdInline = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strike?: boolean;
  link?: string;
};

export type MdBlock =
  | { type: 'paragraph'; spans: MdInline[] }
  | { type: 'heading'; level: 1 | 2 | 3 | 4; spans: MdInline[] }
  | { type: 'code'; language?: string; code: string }
  | { type: 'quote'; spans: MdInline[] }
  // `start` is the number the model wrote on an ordered list's first item
  // (0 is valid). It is absent on unordered lists and on list blocks built by
  // hand before this field existed; the renderer treats absent as 1.
  | { type: 'list'; ordered: boolean; start?: number; items: MdInline[][] }
  | { type: 'hr' };

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const HEADING = /^(#{1,4})\s+(.*)$/;
const FENCE = /^\s*(```+|~~~+)\s*([\w+-]*)\s*$/;
const HR = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^>\s?(.*)$/;

const WORD_CHAR = /\w/;
const SPACE_CHAR = /\s/;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR.test(ch);
}

function isSpaceChar(ch: string | undefined): boolean {
  return ch !== undefined && SPACE_CHAR.test(ch);
}

/**
 * Is this `__` run one half of an identifier-like dunder (`__init__`,
 * `__name__`, `foo__bar__`)? Prose bold hugs words too, so the character
 * before the opener cannot tell them apart — `__init__.py` begins the text
 * with no character before it. A run belongs to a dunder when an identifier
 * joins it to the matching `__` run with no space or punctuation between.
 */
function isDunderHalf(text: string, at: number): boolean {
  // Opening half: walk the identifier to the next `__`.
  if (isWordChar(text[at + 2])) {
    for (let j = at + 2; j < text.length; j += 1) {
      if (text[j] === '_' && text[j + 1] === '_') return true;
      if (isSpaceChar(text[j]) || !isWordChar(text[j])) break;
    }
  }
  // Closing half: walk the identifier back to the previous `__`.
  if (isWordChar(text[at - 1])) {
    for (let j = at - 1; j >= 1; j -= 1) {
      if (text[j] === '_' && text[j - 1] === '_') return true;
      if (isSpaceChar(text[j]) || !isWordChar(text[j])) break;
    }
  }
  return false;
}

/**
 * Flanking rules for an emphasis opener: it may not be followed by whitespace
 * (so `2 * 3 * 4` and a lone `*` keep their stars). `__` also may not open
 * inside an identifier (`foo__bar`) or form a dunder (`__init__`). Plain `_`
 * additionally needs a word boundary at the start, which keeps snake_case
 * literal.
 */
function canOpenEmphasis(text: string, at: number, marker: string): boolean {
  const next = marker.length === 2 ? text[at + 2] : text[at + 1];
  if (next === undefined || isSpaceChar(next)) return false;
  if (marker === '__') {
    return !isWordChar(text[at - 1]) && !isDunderHalf(text, at);
  }
  if (marker === '_') {
    return at === 0 || isSpaceChar(text[at - 1]);
  }
  return true;
}

/**
 * First closer the flanking rules accept: it may not be preceded by
 * whitespace, a `__` closer may not be a dunder half, and a lone `*`/`_`
 * never closes on the first half of a `**`/`__` run, so `*a **b** c*` leaves
 * the inner pair for the bold branch.
 */
function findCloser(text: string, from: number, marker: string): number {
  for (let at = from; at <= text.length - marker.length; at += 1) {
    if (!text.startsWith(marker, at)) continue;
    if (marker.length === 1 && text[at + 1] === marker) {
      at += 1;
      continue;
    }
    if (isSpaceChar(text[at - 1])) continue;
    if (marker === '__' && isDunderHalf(text, at)) continue;
    return at;
  }
  return -1;
}

function mergeAdjacent(spans: MdInline[]): MdInline[] {
  const merged: MdInline[] = [];
  for (const span of spans) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      prev.bold === span.bold &&
      prev.italic === span.italic &&
      prev.code === span.code &&
      prev.strike === span.strike &&
      prev.link === span.link
    ) {
      prev.text += span.text;
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

export function parseInline(text: string): MdInline[] {
  const spans: MdInline[] = [];
  let i = 0;
  let plainStart = 0;

  const pushPlain = (end: number) => {
    if (end > plainStart) spans.push({ text: text.slice(plainStart, end) });
  };

  while (i < text.length) {
    // Inline code span (backticks; no nested parsing inside)
    if (text[i] === '`') {
      const ticks = text.slice(i).match(/^`+/)?.[0] ?? '`';
      const close = text.indexOf(ticks, i + ticks.length);
      if (close > i + ticks.length - 1 && close !== -1) {
        pushPlain(i);
        spans.push({ text: text.slice(i + ticks.length, close), code: true });
        i = close + ticks.length;
        plainStart = i;
        continue;
      }
    }

    // Link [label](url)
    if (text[i] === '[') {
      const closeBracket = text.indexOf(']', i + 1);
      if (closeBracket > i + 1 && text[closeBracket + 1] === '(') {
        const closeParen = text.indexOf(')', closeBracket + 2);
        if (closeParen > closeBracket + 2) {
          pushPlain(i);
          spans.push({
            text: text.slice(i + 1, closeBracket),
            link: text.slice(closeBracket + 2, closeParen),
          });
          i = closeParen + 1;
          plainStart = i;
          continue;
        }
      }
    }

    // Bold **text** / __text__ (may contain nested inline styles)
    if (text.startsWith('**', i) || text.startsWith('__', i)) {
      const marker = text.slice(i, i + 2);
      const close = canOpenEmphasis(text, i, marker) ? findCloser(text, i + 2, marker) : -1;
      if (close > i + 2) {
        pushPlain(i);
        const inner = parseInline(text.slice(i + 2, close)).map((span) => ({
          ...span,
          bold: true,
        }));
        spans.push(...inner);
        i = close + 2;
        plainStart = i;
        continue;
      }
    }

    // Strikethrough ~~text~~
    if (text.startsWith('~~', i)) {
      const close = text.indexOf('~~', i + 2);
      if (close > i + 2) {
        pushPlain(i);
        spans.push({ text: text.slice(i + 2, close), strike: true });
        i = close + 2;
        plainStart = i;
        continue;
      }
    }

    // Italic *text* / _text_ (both obey the flanking rules above; plain `_`
    // still needs a word boundary at the start to keep snake_case literal)
    if (text[i] === '*' || text[i] === '_') {
      const marker = text[i];
      const close = canOpenEmphasis(text, i, marker) ? findCloser(text, i + 1, marker) : -1;
      if (close > i + 1) {
        pushPlain(i);
        spans.push({ text: text.slice(i + 1, close), italic: true });
        i = close + 1;
        plainStart = i;
        continue;
      }
    }

    i += 1;
  }

  pushPlain(text.length);
  return mergeAdjacent(spans.filter((span) => span.text.length > 0));
}

export function parseMarkdown(text: string): MdBlock[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: MdBlock[] = [];
  let paragraph: string[] = [];
  let i = 0;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const spans = parseInline(paragraph.join('\n'));
    if (spans.some((span) => span.text.trim().length > 0)) {
      blocks.push({ type: 'paragraph', spans });
    }
    paragraph = [];
  };

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block. An unterminated fence (truncated turn, model cut
    // off mid-block) stays prose so the rest of the reply does not flip into
    // one monospace block the moment streaming ends.
    const fence = line.match(FENCE);
    if (fence) {
      const fenceChar = fence[1][0];
      const closer = fenceChar.repeat(3);
      let closeAt = i + 1;
      while (closeAt < lines.length && !lines[closeAt].trimStart().startsWith(closer)) {
        closeAt += 1;
      }
      if (closeAt < lines.length) {
        flushParagraph();
        const language = fence[2] || undefined;
        blocks.push({ type: 'code', language, code: lines.slice(i + 1, closeAt).join('\n') });
        i = closeAt + 1;
        continue;
      }
    }

    // Blank line ends the current paragraph
    if (line.trim() === '') {
      flushParagraph();
      i += 1;
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      flushParagraph();
      blocks.push({
        type: 'heading',
        level: heading[1].length as 1 | 2 | 3 | 4,
        spans: parseInline(heading[2].trim()),
      });
      i += 1;
      continue;
    }

    if (HR.test(line)) {
      flushParagraph();
      blocks.push({ type: 'hr' });
      i += 1;
      continue;
    }

    const quote = line.match(QUOTE);
    if (quote) {
      flushParagraph();
      const quoteLines: string[] = [];
      while (i < lines.length) {
        const match = lines[i].match(QUOTE);
        if (!match) break;
        quoteLines.push(match[1]);
        i += 1;
      }
      blocks.push({ type: 'quote', spans: parseInline(quoteLines.join('\n')) });
      continue;
    }

    const listItem = line.match(LIST_ITEM);
    if (listItem) {
      flushParagraph();
      const ordered = /^\d/.test(listItem[2]);
      // Keep the first written marker, so a list resumed after a paragraph or
      // code block ("... 3. 4.") still displays the numbers the model wrote.
      const start = ordered ? parseInt(listItem[2], 10) : undefined;
      const items: MdInline[][] = [];
      while (i < lines.length) {
        const match = lines[i].match(LIST_ITEM);
        if (!match) break;
        items.push(parseInline(match[3]));
        i += 1;
      }
      blocks.push(
        start === undefined
          ? { type: 'list', ordered, items }
          : { type: 'list', ordered, start, items },
      );
      continue;
    }

    paragraph.push(line);
    i += 1;
  }

  flushParagraph();
  return blocks;
}

/**
 * Blocks for the chat bubble.
 *
 * A streaming body is one plain paragraph so each token does not re-parse
 * the whole growing buffer. Markdown runs when the stream completes.
 */
export function markdownBlocksForDisplay(text: string, streaming = false): MdBlock[] {
  if (streaming) {
    return text.length === 0 ? [] : [{ type: 'paragraph', spans: [{ text }] }];
  }
  return parseMarkdown(text);
}
