import { ansiPlainText, parseAnsiText } from '@/lib/terminal/ansi';
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
});

describe('terminal output model', () => {
  test('stripAnsi removes control sequences', () => {
    expect(stripAnsi('\u001b[32mgreen\u001b[0m')).toBe('green');
  });

  test('appendTerminalChunk preserves ANSI for later paint-time rendering', () => {
    const lines = appendTerminalChunk([], '\u001b[32mgreen\u001b[0m');
    expect(lines.map((line) => line.text)).toEqual(['\u001b[32mgreen\u001b[0m']);
    expect(ansiPlainText(lines[0].text)).toBe('green');
  });

  test('appendTerminalChunk strips carriage returns only', () => {
    const lines = appendTerminalChunk([], 'a\rb');
    expect(lines.map((line) => line.text)).toEqual(['ab']);
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
});
