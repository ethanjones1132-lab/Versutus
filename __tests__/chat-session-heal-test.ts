declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readProvider(): string {
  return nodeFs
    .readFileSync([__dirname, '..', 'src', 'context', 'gateway-provider.tsx'].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

function sendMessageBody(src: string): string {
  const start = src.indexOf('const sendMessage = useCallback(');
  expect(start).toBeGreaterThan(-1);
  return src.slice(start, src.indexOf('await client.streamChat(', start));
}

// 2026-09-19: after a host restart the phone connected while Hermes was still
// booting, so the session catalogue read failed and the thread stayed
// sessionless. Chat answered anyway (statelessly), but the call sheet refused
// with "This thread does not have a chat session yet" after a real reply.
describe('a sessionless thread heals on its next send', () => {
  test('sendMessage resolves a session before streaming when the thread has none', () => {
    const body = sendMessageBody(readProvider());
    expect(body).toMatch(/if \(!sessionIdRef\.current\) \{[\s\S]*resolveResumeSession\(/);
  });

  test('the resolved session becomes the live thread for the call sheet', () => {
    const body = sendMessageBody(readProvider());
    expect(body).toContain('sessionIdRef.current = outcome.sessionId;');
    expect(body).toContain('setCurrentSessionId(outcome.sessionId);');
  });

  test('a session that arrived meanwhile is never overwritten', () => {
    const body = sendMessageBody(readProvider());
    expect(body).toContain('if (outcome.sessionId && !sessionIdRef.current)');
  });
});
