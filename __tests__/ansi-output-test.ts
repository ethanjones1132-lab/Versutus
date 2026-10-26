import { ansiPlainText, ansiPlainTextUpTo, parseAnsiText } from '@/lib/terminal/ansi';
import { appendTerminalChunk, isPromptLine, stripAnsi, terminalLinesFromText } from '@/lib/terminal/output';

describe('parseAnsiText', () => {
  test('plain text is a single default span', () => {
    expect(parseAnsiText('hello')).toEqual([
      { text: 'hello', fg: 'default', bg: 'default', bold: false, dim: false },
    ]);
  });

  test('maps foreground colour and honours reset', () => {
    const spans = parseAnsiText('\u001b[32mgreen\u001b[0m');
    expect(spans).toEqual([
      { text: 'green', fg: 'green', bg: 'default', bold: false, dim: false },
    ]);
  });

  test('splits styling transitions into separate spans', () => {
    const spans = parseAnsiText('a\u001b[1mb\u001b[0mc');
    expect(spans.map((span) => span.text)).toEqual(['a', 'b', 'c']);
    expect(spans[1].bold).toBe(true);
    expect(spans[2].bold).toBe(false);
  });

  test('merges adjacent spans with identical styling', () => {
    const spans = parseAnsiText('\u001b[32ma\u001b[32mb');
    expect(spans).toHaveLength(1);
    expect(spans[0].text).toBe('ab');
    expect(spans[0].fg).toBe('green');
  });

  test('applies combined parameters from one SGR', () => {
    const spans = parseAnsiText('\u001b[1;32mhi');
    expect(spans[0].bold).toBe(true);
    expect(spans[0].fg).toBe('green');
  });

  test('maps bright colours', () => {
    expect(parseAnsiText('\u001b[91mhi')[0].fg).toBe('brightRed');
  });

  test('maps background colours', () => {
    expect(parseAnsiText('\u001b[41mhi')[0].bg).toBe('red');
  });

  test('maps dim and resets it with 22', () => {
    expect(parseAnsiText('\u001b[2mdim')[0].dim).toBe(true);
    const spans = parseAnsiText('\u001b[2;1mx\u001b[22my');
    expect(spans[0].dim).toBe(true);
    expect(spans[1].dim).toBe(false);
    expect(spans[1].bold).toBe(false);
  });

  test('consumes non-SGR CSI without changing the palette', () => {
    const spans = parseAnsiText('\u001b[2K\u001b[1Ahi');
    expect(spans).toEqual([
      { text: 'hi', fg: 'default', bg: 'default', bold: false, dim: false },
    ]);
  });

  test('consumes charset escapes', () => {
    expect(ansiPlainText('\u001b(0hello')).toBe('hello');
  });

  test('consumes 256-colour and truecolor parameters but stays default', () => {
    expect(parseAnsiText('\u001b[38;5;196mhi')[0].fg).toBe('default');
    expect(parseAnsiText('\u001b[38;2;255;0;0mhi')[0].fg).toBe('default');
  });

  test('consumes OSC window titles terminated by BEL', () => {
    expect(ansiPlainText('\u001b]0;user@host:~\u0007$ ')).toBe('$ ');
  });

  test('consumes OSC window titles terminated by ST', () => {
    expect(ansiPlainText('\u001b]0;user@host:~\u001b\\$ ')).toBe('$ ');
  });

  test('keeps SGR styling and adjacent text around a consumed OSC title', () => {
    const spans = parseAnsiText('\u001b]0;title\u0007before \u001b[32mgreen\u001b[0m after');
    expect(spans.map((span) => span.text)).toEqual(['before ', 'green', ' after']);
    expect(spans[1].fg).toBe('green');
    expect(spans[2].fg).toBe('default');
  });

  test('consumes CSI controls that follow a title sequence', () => {
    expect(parseAnsiText('\u001b]0;t\u0007\u001b[2K\u001b[1Ahi')).toEqual([
      { text: 'hi', fg: 'default', bg: 'default', bold: false, dim: false },
    ]);
  });

  test('consumes two-byte escapes such as ESC =, ESC > and ESC 7', () => {
    expect(ansiPlainText('\u001b=\u001b>text')).toBe('text');
    expect(ansiPlainText('\u001b7saved\u001b8')).toBe('saved');
  });

  test('preserves Unicode glyphs around consumed control sequences', () => {
    expect(ansiPlainText('\u001b]0;t\u0007café 🚀\u001b[1mdone')).toBe('café 🚀done');
    const spans = parseAnsiText('🚀\u001b[31m🚀');
    expect(spans.map((span) => span.text)).toEqual(['🚀', '🚀']);
    expect(spans[1].fg).toBe('red');
  });

  test('defines bounded behaviour for truncated and malformed escapes', () => {
    // A truncated OSC has no visible payload; it is dropped to the end of the line.
    expect(ansiPlainText('prompt\u001b]0;unterminated')).toBe('prompt');
    // A lone ESC or an incomplete CSI is an invisible control, not a glyph.
    expect(ansiPlainText('prompt\u001b')).toBe('prompt');
    expect(ansiPlainText('prompt\u001b[31')).toBe('prompt');
    expect(ansiPlainText('prompt\u001b(')).toBe('prompt');
    // A malformed CSI ends at the offending byte and the rest stays visible.
    expect(ansiPlainText('a\u001b[31\tb')).toBe('a\tb');
    // A malformed ESC is dropped and the next sequence still applies.
    expect(parseAnsiText('\u001b\u001b[31mred')).toEqual([
      { text: 'red', fg: 'red', bg: 'default', bold: false, dim: false },
    ]);
  });

  test('parses long plain and escape-rich lines without losing text', () => {
    const plain = 'a'.repeat(20000);
    expect(ansiPlainText(plain)).toBe(plain);

    const rich = '\u001b[32mx\u001b[0m'.repeat(2000);
    expect(ansiPlainText(rich)).toBe('x'.repeat(2000));
    const spans = parseAnsiText(rich);
    expect(spans).toHaveLength(1);
    expect(spans[0].fg).toBe('green');
  });

  test('never rescans the unconsumed suffix per character', () => {
    // Complexity evidence without wall-clock timing: the previous parser called
    // `text.slice(cursor)` on every character and matched three regexes against
    // the whole remainder, so a plain line made one string copy per character.
    const plainSpy = jest.spyOn(String.prototype, 'slice');
    let plainResult = '';
    let plainSliceCalls = 0;
    try {
      plainResult = ansiPlainText('a'.repeat(20000));
      plainSliceCalls = plainSpy.mock.calls.length;
    } finally {
      plainSpy.mockRestore();
    }
    expect(plainResult).toBe('a'.repeat(20000));
    expect(plainSliceCalls).toBe(0);

    const richSpy = jest.spyOn(String.prototype, 'slice');
    let richResult = '';
    let richSliceCalls = 0;
    try {
      richResult = ansiPlainText('\u001b[32mx\u001b[0m'.repeat(2000));
      richSliceCalls = richSpy.mock.calls.length;
    } finally {
      richSpy.mockRestore();
    }
    expect(richResult).toBe('x'.repeat(2000));
    // At most one parameter copy per SGR sequence (4000 here, over 18000 chars).
    expect(richSliceCalls).toBeLessThanOrEqual(4000);
  });

  test('reads a bounded visible prefix for prompt detection', () => {
    expect(ansiPlainTextUpTo('  hi  ', 96)).toBe('hi');
    expect(ansiPlainTextUpTo('a'.repeat(200), 96)).toBeNull();
    expect(ansiPlainTextUpTo(`\u001b]0;${'x'.repeat(5000)}\u0007$`, 96)).toBe('$');
  });
});

describe('terminal output model', () => {
  test('stripAnsi removes control sequences', () => {
    expect(stripAnsi('\u001b[32mgreen\u001b[0m')).toBe('green');
    expect(stripAnsi('\u001b]0;title\u0007prompt$ ')).toBe('prompt$ ');
    expect(stripAnsi('\u001b=\u001b>prompt$ ')).toBe('prompt$ ');
  });

  test('appendTerminalChunk preserves ANSI for later paint-time rendering', () => {
    const lines = appendTerminalChunk([], '\u001b[32mgreen\u001b[0m');
    expect(lines.map((line) => line.text)).toEqual(['\u001b[32mgreen\u001b[0m']);
    expect(ansiPlainText(lines[0].text)).toBe('green');
  });

  test('appendTerminalChunk applies carriage-return overwrite, not concatenation', () => {
    // `\r` returns to column 0: `b` overwrites `a`, so the redraw state wins.
    // The old assertion pinned `ab`, which piled every progress redraw up.
    const lines = appendTerminalChunk([], 'a\rb');
    expect(lines.map((line) => line.text)).toEqual(['b']);
  });

  test('appends chunks across line boundaries', () => {
    let lines = appendTerminalChunk([], 'one\n two');
    lines = appendTerminalChunk(lines, '\nthree');
    expect(lines.map((line) => line.text)).toEqual(['one', ' two', 'three']);
  });

  test('caps retained lines and converts text snapshots', () => {
    const lines = appendTerminalChunk([], 'a\nb\nc', 2);
    expect(lines.map((line) => line.text)).toEqual(['b', 'c']);
    expect(terminalLinesFromText('hello').map((line) => line.text)).toEqual(['hello']);
  });
});

describe('isPromptLine', () => {
  test('recognises common shell prompts', () => {
    expect(isPromptLine('$')).toBe(true);
    expect(isPromptLine('user@host:~$')).toBe(true);
    expect(isPromptLine('(venv) python@box:~/proj>')).toBe(true);
    expect(isPromptLine('C:\\projects\\app>')).toBe(true);
    expect(isPromptLine('mysql> ')).toBe(true);
  });

  test('rejects output that is merely mono text', () => {
    expect(isPromptLine('hello world')).toBe(false);
    expect(isPromptLine('123$')).toBe(false);
    expect(isPromptLine('')).toBe(false);
  });

  test('rejects absurdly long lines', () => {
    expect(isPromptLine(`${'a'.repeat(97)}$`)).toBe(false);
  });

  test('accepts short visible prompts wrapped in long invisible controls', () => {
    // A shell title sequence can be far longer than the prompt it precedes;
    // only the visible text may count toward the prompt length cap.
    const title = `\u001b]0;${'x'.repeat(500)}\u0007`;
    expect(isPromptLine(`${title}\u001b[32m$\u001b[0m`)).toBe(true);
    expect(isPromptLine(`${title}\u001b[1;32muser@host:~$\u001b[0m`)).toBe(true);
    expect(isPromptLine('\u001b]0;t\u001b\\mysql> ')).toBe(true);
  });

  test('rejects long visible lines without parsing them in full', () => {
    expect(isPromptLine('a'.repeat(5000))).toBe(false);
    expect(isPromptLine(`\u001b[32m${'a'.repeat(500)}\u001b[0m$`)).toBe(false);
  });

  test('ignores whitespace-only and control-only lines', () => {
    expect(isPromptLine('   ')).toBe(false);
    expect(isPromptLine('\u001b[32m\u001b[0m')).toBe(false);
    expect(isPromptLine('\u001b]0;title\u0007')).toBe(false);
  });
});
