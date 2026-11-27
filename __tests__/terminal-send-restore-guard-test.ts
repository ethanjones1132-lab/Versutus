declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readScreen(): string {
  return nodeFs
    .readFileSync([__dirname, '..', 'src', 'components', 'terminal', 'terminal-screen.tsx'].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

function readSend(src: string): string {
  const start = src.indexOf('const sendToTerminal = useCallback(');
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('}, [activeGateway, input]);', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

// The send clears the field before awaiting the gateway, then used to write
// the submitted text back unconditionally on failure — replacing anything the
// operator typed during the round-trip. It now restores only while the field
// is still empty.
describe('terminal send failure restore', () => {
  test('the failure restores through a guard on the current field value', () => {
    const send = readSend(readScreen());
    expect(send).toContain('setInput((current) => (current.length === 0 ? value : current));');
    // The unconditional write-back is the bug: it clobbers newer typing.
    expect(send).not.toContain('setInput(value);');
  });

  test('the guard sits in the catch, after the clear and the awaited send', () => {
    const send = readSend(readScreen());
    const clear = send.indexOf("setInput('');");
    const attempt = send.indexOf('await sendTerminalInput(');
    const restore = send.indexOf('setInput((current) =>');
    const error = send.indexOf('setTerminalError(message);');
    expect(clear).toBeGreaterThan(-1);
    expect(attempt).toBeGreaterThan(clear);
    expect(restore).toBeGreaterThan(attempt);
    expect(restore).toBeLessThan(error);
  });

  test('nothing else writes the field, so a successful send stays cleared', () => {
    const send = readSend(readScreen());
    const clear = send.indexOf("setInput('');");
    const restore = send.indexOf('setInput((current) =>');
    // The next `setInput(` after the clear is the guarded restore.
    expect(send.indexOf('setInput(', clear + 1)).toBe(restore);
  });
});
