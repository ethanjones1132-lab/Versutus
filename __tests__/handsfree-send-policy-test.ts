declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(...parts: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

function between(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  if (start === -1) return '';
  const rest = src.slice(start + startMarker.length);
  const end = rest.indexOf(endMarker);
  return end === -1 ? rest : rest.slice(0, end);
}

const provider = readSource('src', 'context', 'gateway-provider.tsx');

describe('sendChatInput carries a source without changing today’s callers', () => {
  test('the outcome union names offline', () => {
    const union = between(provider, 'export type SendChatInputOutcome =', ';');
    expect(union).toContain("'offline'");
  });

  test('the options accept a source and the composer default is untouched', () => {
    expect(provider).toContain("source?: ChatInputSource");
    // The offline queue branch is still the composer’s, unchanged.
    const offline = between(provider, 'if (!fromQueue &&', 'return \'queued\';');
    expect(offline).toContain('queueOfflineInput(trimmed');
    expect(offline).toContain("{ botId: options?.botId, sessionId: options?.sessionId }");
  });

  test('the composer slash-command path is unchanged', () => {
    expect(provider).toContain('isSlashCommandInput(trimmed)');
    expect(provider).toContain('decideBusySlash(trimmed, isCommandRunning, runningCommandLabel)');
  });
});

describe('the hands-free call send path', () => {
  const sendInputBlock = between(
    provider,
    'const sendChatInput = useCallback(',
    'const openModelPicker = useCallback(',
  );
  const callBlock = between(
    sendInputBlock,
    'if (isHandsfreeCallSource(source)) {',
    '// Pre-flight guard',
  );

  test('is gated before any queue is touched', () => {
    expect(callBlock).toContain('decideCallSend');
    expect(callBlock).not.toContain('queueOfflineInput');
    expect(callBlock).toContain("if (decision === 'offline') return 'offline';");
    expect(callBlock).toContain("if (decision === 'busy') return 'busy';");
  });

  test('bypasses the slash-command dispatch entirely, so a heard slash is plain text', () => {
    expect(callBlock).toContain('sendMessage(trimmed, options?.messageId, source)');
    expect(callBlock).not.toContain('isSlashCommandInput');
  });

  test('requires the captured gateway and session to still be current', () => {
    expect(callBlock).toContain("status === 'connected'");
    expect(callBlock).toContain('sessionIdRef.current');
    expect(callBlock).toContain('isSending || isCommandRunning');
  });
});

describe('a call turn appends its own user message with the supplied id', () => {
  test('sendMessage accepts the source and appends with addUserMessage’s explicit id', () => {
    const send = between(provider, 'const sendMessage = useCallback(', 'const runId = createMessageId');
    expect(send).toContain('source?: ChatInputSource');
    expect(send).toContain('if (isHandsfreeCallSource(source)) {');
    expect(send).toContain('addUserMessage(prev, trimmed, existingMessageId)');
    // The ordinary existingMessageId branch only clears `queued`; that is not
    // enough to make a fresh call turn render, which is why the call path
    // appends instead.
    expect(send).toContain('? { ...message, queued: false } : message');
  });
});

describe('no backend-name branching and no invented capability', () => {
  test('the send policy names no backend and checks no realtime capability', () => {
    const source = readSource('src', 'lib', 'gateway', 'chat-input-source.ts');
    expect(source).not.toMatch(/hermes|opencode|codex|claude-code/i);
    expect(source).not.toContain('realtime-voice');
    expect(provider).not.toContain('realtime-voice');
  });
});
