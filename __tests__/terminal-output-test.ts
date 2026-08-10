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
});
