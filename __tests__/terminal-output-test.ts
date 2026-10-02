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
});
