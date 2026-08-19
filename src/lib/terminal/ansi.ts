// ANSI SGR parsing for the terminal pane.
//
// Shell/RPC output arrives as plain text with ECMA-48 SGR escape sequences
// (`\x1b[<params>m`) that encode colour and emphasis. The pane renders the
// stored text through this parser to produce styled spans; control sequences
// are consumed and never shown raw. Non-SGR escapes (cursor movement, erase,
// charset selection) are also consumed without affecting the palette.
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

const SGR = /\x1b\[([0-9;]*)m/;
const OTHER_CSI = /\x1b\[[0-?]*[ -/]*[@-~]/;
const OTHER_ESC = /\x1b[()][0-9A-Za-z]/;

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
    const rest = text.slice(cursor);
    const sgr = rest.match(SGR);
    if (sgr && sgr.index === 0) {
      flush();
      applySgr(sgr[1], state);
      cursor += sgr[0].length;
      continue;
    }
    const csi = rest.match(OTHER_CSI);
    if (csi && csi.index === 0) {
      flush();
      cursor += csi[0].length;
      continue;
    }
    const esc = rest.match(OTHER_ESC);
    if (esc && esc.index === 0) {
      flush();
      cursor += esc[0].length;
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
