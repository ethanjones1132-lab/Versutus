declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';

function readSource(...parts: string[]): string {
  const nodeFs = jest.requireActual('fs') as {
    readFileSync(path: string, encoding: string): string;
  };
  return nodeFs.readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8');
}

function bubbleSrc(): string {
  return readSource('src', 'components', 'chat', 'message-bubble.tsx');
}

function reducerSrc(): string {
  return readSource('src', 'lib', 'gateway', 'message-reducer.ts');
}

test('retry-rendered-on-error-bubble: a settled non-interrupted Error: assistant bubble offers a retry', () => {
  const src = bubbleSrc();
  // The new gate keys off the convertStreamError verdict prefix, and only for
  // settled plain assistant bubbles — never commands, streaming turns, or
  // interrupted turns (those keep their own actions).
  expect(src).toMatch(/message\.text\.startsWith\('Error:'\)/);
  expect(src).toMatch(/!isCommand && !isInterrupted && !message\.streaming && !isUser && onResume/);
});

test('resend-path-reuse: the error-bubble retry resends through onResume, not a new send path', () => {
  const src = bubbleSrc();
  // Resume (interrupted) plus the new error retry: both call onResume(message),
  // which chat-screen wires to handleResumeMessage's previous-user-text resend.
  const resumeCalls = src.match(/onResume\(message\)/g) ?? [];
  expect(resumeCalls.length).toBeGreaterThanOrEqual(2);
  // The bubble must not grow its own sender — no direct sendChatInput import.
  expect(src).not.toMatch(/sendChatInput/);
});

test('command-retry-untouched: failed slash-command bubbles keep their own Retry gate', () => {
  const src = bubbleSrc();
  expect(src).toContain("commandStatus === 'error' && onRetry && message.command?.input");
});

test('resume-gate-untouched: interrupted bubbles keep their own Send-again gate', () => {
  const src = bubbleSrc();
  expect(src).toContain('{isInterrupted && onResume ? (');
  expect(src).toContain('interruptedSendAgainLabel()');
});

test('verdict-copy-untouched: the failure verdict still lands as `Error: …` text', () => {
  const src = reducerSrc();
  expect(src).toContain('text: `Error: ${errorMessage}`');
});
