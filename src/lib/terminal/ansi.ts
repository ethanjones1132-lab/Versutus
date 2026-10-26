// ANSI parsing for the terminal pane.
//
// Shell/RPC output arrives as plain text with ECMA-48 control sequences: SGR
// (`\x1b[<params>m`) for colour and emphasis, other CSI sequences for cursor
// movement and erases, two-byte escapes (`ESC =`, `ESC >`, `ESC ( 0`), and
// string sequences such as OSC (`ESC ] ... BEL`/`ESC \`) that shell prompts use
// for window titles. The pane renders the stored text through this parser to
// produce styled spans; every sequence is consumed and never shown raw, so the
// display, copy path and prompt detection all agree on the visible text.
//
// The palette stay inside the Versutus design system (tokens.ts) — 256-colour
// and truecolor parameters are deliberately not mapped; callers fall back to
// the default colour rather than letting arbitrary hex leak into the UI.

export type AnsiColor =
  | 'black'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan'
  | 'white'
  | 'brightBlack'
  | 'brightRed'
  | 'brightGreen'
  | 'brightYellow'
  | 'brightBlue'
  | 'brightMagenta'
  | 'brightCyan'
  | 'brightWhite'
  | 'default';

export type AnsiSpan = {
  text: string;
  fg: AnsiColor;
  bg: AnsiColor;
  bold: boolean;
  dim: boolean;
};

const FG_BASIC: Record<number, AnsiColor> = {
  30: 'black', 31: 'red', 32: 'green', 33: 'yellow',
  34: 'blue', 35: 'magenta', 36: 'cyan', 37: 'white',
};

const FG_BRIGHT: Record<number, AnsiColor> = {
  90: 'brightBlack', 91: 'brightRed', 92: 'brightGreen', 93: 'brightYellow',
  94: 'brightBlue', 95: 'brightMagenta', 96: 'brightCyan', 97: 'brightWhite',
};

const BG_BASIC: Record<number, AnsiColor> = {
  40: 'black', 41: 'red', 42: 'green', 43: 'yellow',
  44: 'blue', 45: 'magenta', 46: 'cyan', 47: 'white',
};

const BG_BRIGHT: Record<number, AnsiColor> = {
  100: 'brightBlack', 101: 'brightRed', 102: 'brightGreen', 103: 'brightYellow',
  104: 'brightBlue', 105: 'brightMagenta', 106: 'brightCyan', 107: 'brightWhite',
};

const ESC = 0x1b;
const BEL = 0x07;
const CSI_INTRODUCER = 0x5b; // '['
// OSC ']', DCS 'P', SOS 'X', PM '^', APC '_'. All are payload up to ST
// (`ESC \`); OSC also ends at BEL, which shells use for window titles.
const STRING_INTRODUCERS = new Set<number>([0x5d, 0x50, 0x58, 0x5e, 0x5f]);
const WHITESPACE = /\s/;

type EscapeScan = {
  /** Index of the first character after the consumed sequence. */
  end: number;
  /** SGR parameter bytes when the sequence is `ESC [ <params> m`. */
  sgr: string | null;
};

function isCsiParameter(code: number): boolean {
  return code >= 0x30 && code <= 0x3f; // digits, ';', ':', '?', …
}

function isCsiIntermediate(code: number): boolean {
  return code >= 0x20 && code <= 0x2f; // ' ', '#', '(', ')', …
}

function isEscapeFinal(code: number): boolean {
  return code >= 0x30 && code <= 0x7e; // digits, '=', '>', letters, '~'
}

/**
 * Scan the payload of a string sequence, starting just after its introducer.
 * Returns the index of the first character after the terminator. An unterminated
 * string consumes the rest of the input: a terminal waiting for the terminator
 * would not paint its payload, so dropping it is the bounded, leak-free choice.
 */
function scanStringBody(text: string, start: number, belTerminates: boolean): number {
  let cursor = start;
  while (cursor < text.length) {
    const code = text.charCodeAt(cursor);
    if (belTerminates && code === BEL) return cursor + 1;
    if (code === ESC) {
      // ST (`ESC \`) closes the string. Any other ESC abandons it and starts its
      // own sequence, so a misplaced escape cannot swallow the rest of the line.
      if (cursor + 1 < text.length && text.charCodeAt(cursor + 1) === 0x5c) {
        return cursor + 2;
      }
      return cursor;
    }
    cursor += 1;
  }
  return cursor;
}

/**
 * Scan one escape sequence starting at `start` (an ESC byte). Every branch
 * moves the cursor forward and the text is walked once, so a full parse stays
 * linear in the input length instead of re-scanning the suffix per character.
 */
function scanEscape(text: string, start: number): EscapeScan {
  let cursor = start + 1;
  if (cursor >= text.length) return { end: text.length, sgr: null }; // bare ESC

  const introducer = text.charCodeAt(cursor);

  if (introducer === CSI_INTRODUCER) {
    cursor += 1;
    const paramsStart = cursor;
    while (cursor < text.length && isCsiParameter(text.charCodeAt(cursor))) cursor += 1;
    const paramsEnd = cursor;
    while (cursor < text.length && isCsiIntermediate(text.charCodeAt(cursor))) cursor += 1;
    if (cursor >= text.length) return { end: text.length, sgr: null }; // truncated CSI
    const final = text.charCodeAt(cursor);
    // A malformed byte ends the sequence here; it stays as visible text rather
    // than being swallowed with the control bytes that preceded it.
    if (!(final >= 0x40 && final <= 0x7e)) return { end: cursor, sgr: null };
    // `m` with semicolon/digit parameters is SGR; private or intermediate forms
    // are control-only, and their styling is left untouched.
    const params = paramsEnd === cursor ? text.slice(paramsStart, paramsEnd) : null;
    const sgr = final === 0x6d && params !== null && /^[0-9;]*$/.test(params) ? params : null;
    return { end: cursor + 1, sgr };
  }

  if (STRING_INTRODUCERS.has(introducer)) {
    return { end: scanStringBody(text, cursor + 1, introducer === 0x5d), sgr: null };
  }

  // Generic escape: intermediates then one final byte. This covers two-byte
  // sequences (`ESC =`, `ESC >`, `ESC 7`) and charset selection (`ESC ( 0`).
  while (cursor < text.length && isCsiIntermediate(text.charCodeAt(cursor))) cursor += 1;
  if (cursor < text.length && isEscapeFinal(text.charCodeAt(cursor))) {
    return { end: cursor + 1, sgr: null };
  }
  // Truncated or malformed: drop the ESC and let the remaining bytes stand as text.
  return { end: cursor, sgr: null };
}

function applySgr(rawParams: string, state: { fg: AnsiColor; bg: AnsiColor; bold: boolean; dim: boolean }) {
  const params =
    rawParams.length === 0
      ? [0]
      : rawParams.split(';').map((part) => {
          const value = Number(part);
          return Number.isNaN(value) ? 0 : value;
        });

  let i = 0;
  while (i < params.length) {
    const code = params[i];
    if (code === 0) {
      state.fg = 'default';
      state.bg = 'default';
      state.bold = false;
      state.dim = false;
    } else if (code === 1) {
      state.bold = true;
    } else if (code === 2) {
      state.dim = true;
    } else if (code === 22) {
      state.bold = false;
      state.dim = false;
    } else if (code === 39) {
      state.fg = 'default';
    } else if (code === 49) {
      state.bg = 'default';
    } else if (code >= 30 && code <= 37) {
      state.fg = FG_BASIC[code] as AnsiColor;
    } else if (code >= 90 && code <= 97) {
      state.fg = FG_BRIGHT[code] as AnsiColor;
    } else if (code >= 40 && code <= 47) {
      state.bg = BG_BASIC[code] as AnsiColor;
    } else if (code >= 100 && code <= 107) {
      state.bg = BG_BRIGHT[code] as AnsiColor;
    } else if (code === 38 || code === 48) {
      // Extended colour: 38;5;N (256) or 38;2;R;G;B (truecolor). Consume the
      // sub-parameters and stay on the default palette colour.
      const sub = params[i + 1];
      i += sub === 5 ? 2 : sub === 2 ? 4 : 0;
    }
    // 3..9 italic/underline/blink/overline, 23/24/25/29 resets, 39/49 handled
    // above, everything else ignored.
    i += 1;
  }
}

/**
 * Parse a chunk of terminal text into styled spans. `escape` and `control`
 * sequences are consumed; the returned spans contain only the visible glyphs.
 */
export function parseAnsiText(text: string): AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  const state = { fg: 'default' as AnsiColor, bg: 'default' as AnsiColor, bold: false, dim: false };
  let plain = '';
  let cursor = 0;

  const flush = () => {
    if (plain.length === 0) return;
    const last = spans[spans.length - 1];
    if (last && last.fg === state.fg && last.bg === state.bg && last.bold === state.bold && last.dim === state.dim) {
      last.text += plain;
    } else {
      spans.push({ text: plain, fg: state.fg, bg: state.bg, bold: state.bold, dim: state.dim });
    }
    plain = '';
  };

  while (cursor < text.length) {
    if (text.charCodeAt(cursor) === ESC) {
      const escape = scanEscape(text, cursor);
      flush();
      if (escape.sgr !== null) applySgr(escape.sgr, state);
      cursor = escape.end;
      continue;
    }
    plain += text[cursor];
    cursor += 1;
  }
  flush();

  // When SGR resets split a span, merge adjacent spans with identical styling.
  const merged: AnsiSpan[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && last.fg === span.fg && last.bg === span.bg && last.bold === span.bold && last.dim === span.dim) {
      last.text += span.text;
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

/** The visible text of a parsed line, control sequences removed. */
export function ansiPlainText(text: string): string {
  return parseAnsiText(text)
    .map((span) => span.text)
    .join('');
}

/**
 * The trimmed visible text of `text`, or `null` when that text is longer than
 * `limit`. Scanning stops at the first visible character that pushes the
 * trimmed length past `limit`, so callers that only need a short prefix (prompt
 * detection) do not pay to parse a long minified or JSON line in full.
 */
export function ansiPlainTextUpTo(text: string, limit: number): string | null {
  let visible = '';
  let started = false;
  let cursor = 0;

  while (cursor < text.length) {
    if (text.charCodeAt(cursor) === ESC) {
      cursor = scanEscape(text, cursor).end;
      continue;
    }
    const char = text[cursor];
    cursor += 1;
    const space = WHITESPACE.test(char);
    if (!started) {
      if (space) continue; // leading whitespace is trimmed away
      started = true;
    }
    visible += char;
    // Trailing whitespace cannot grow the trimmed length, so an over-long
    // non-space character is a definitive rejection at this point.
    if (!space && visible.length > limit) return null;
  }

  if (!started) return '';
  let end = visible.length;
  while (end > 0 && WHITESPACE.test(visible[end - 1])) end -= 1;
  return end === visible.length ? visible : visible.slice(0, end);
}
