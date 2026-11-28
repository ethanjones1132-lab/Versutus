import { appendTerminalChunk, stripAnsi, terminalLinesFromText } from '@/lib/terminal/output';

describe('terminal output model', () => {
  test('strips ANSI control sequences', () => {
    expect(stripAnsi('\u001b[32mgreen\u001b[0m')).toBe('green');
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

  test('keeps the tail of a line longer than the per-line cap instead of losing it', () => {
    const first = appendTerminalChunk([], 'a'.repeat(6000));
    const after = appendTerminalChunk(first, 'b'.repeat(6000));

    // The overflow becomes continuation line(s): no character is dropped and
    // the end of the line is still reachable.
    const text = after.map((line) => line.text).join('');
    expect(text).toHaveLength(12000);
    expect(text.endsWith('b'.repeat(6000))).toBe(true);
  });

  test('does not mutate the caller’s previous line record', () => {
    const first = appendTerminalChunk([], 'hello');
    const snapshot = first[0];
    appendTerminalChunk(first, ' world');

    expect(snapshot.text).toBe('hello');
  });

  test('honours carriage-return overwrites instead of piling up redraws', () => {
    expect(terminalLinesFromText('10%\r20%\r30%').map((line) => line.text)).toEqual(['30%']);
    // A shorter redraw only overwrites the columns it covers.
    expect(terminalLinesFromText('abcdef\rxy').map((line) => line.text)).toEqual(['xycdef']);
  });

  test('splits a long line at a code-point boundary, never between surrogate halves', () => {
    const text = `${'a'.repeat(8191)}😀${'b'.repeat(20)}`;
    const lines = terminalLinesFromText(text);

    // Nothing is dropped, and the emoji stays whole in the continuation.
    expect(lines.map((line) => line.text).join('')).toBe(text);
    expect(lines[0].text).toHaveLength(8191);
    expect(lines[1].text.startsWith('😀')).toBe(true);
    for (const line of lines) {
      for (let index = 0; index < line.text.length; index += 1) {
        const code = line.text.charCodeAt(index);
        if (code >= 0xd800 && code <= 0xdbff) {
          const next = line.text.charCodeAt(index + 1);
          expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
        }
      }
    }
  });

  test('splits a long line at an escape boundary, never leaving a sequence tail as text', () => {
    // The old fixed-offset cut landed inside `ESC[31m`, so `31m` painted as text.
    const text = `${'a'.repeat(8190)}\u001b[31m${'b'.repeat(10)}\u001b[0m`;
    const lines = terminalLinesFromText(text);

    expect(lines.map((line) => line.text).join('')).toBe(text);
    expect(lines[0].text).not.toMatch(/\u001b\[$/);
    expect(lines[1].text.startsWith('\u001b[31m')).toBe(true);
  });
});
