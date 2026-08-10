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
  | { type: 'list'; ordered: boolean; items: MdInline[][] }
  | { type: 'hr' };

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const HEADING = /^(#{1,4})\s+(.*)$/;
const FENCE = /^\s*(```+|~~~+)\s*([\w+-]*)\s*$/;
const HR = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^>\s?(.*)$/;

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
      const close = text.indexOf(marker, i + 2);
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

    // Italic *text* / _text_ (underscore requires a word boundary start to
    // avoid mangling snake_case)
    if (text[i] === '*' || text[i] === '_') {
      const marker = text[i];
      const boundaryOk = marker === '*' || i === 0 || /\s/.test(text[i - 1]);
      if (boundaryOk) {
        const close = text.indexOf(marker, i + 1);
        if (close > i + 1) {
          pushPlain(i);
          spans.push({ text: text.slice(i + 1, close), italic: true });
          i = close + 1;
          plainStart = i;
          continue;
        }
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

    // Fenced code block
    const fence = line.match(FENCE);
    if (fence) {
      flushParagraph();
      const fenceChar = fence[1][0];
      const language = fence[2] || undefined;
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trimStart().startsWith(fenceChar.repeat(3))) {
        codeLines.push(lines[i]);
        i += 1;
      }
      i += 1; // consume closing fence (or run off the end)
      blocks.push({ type: 'code', language, code: codeLines.join('\n') });
      continue;
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
      const items: MdInline[][] = [];
      while (i < lines.length) {
        const match = lines[i].match(LIST_ITEM);
        if (!match) break;
        items.push(parseInline(match[3]));
        i += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    paragraph.push(line);
    i += 1;
  }

  flushParagraph();
  return blocks;
}
