declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(rel: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...rel].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

function readChatScreen(): string {
  return readSource(['src', 'components', 'chat', 'chat-screen.tsx']);
}

// The transcript EmptyState titles "Waiting for connection" and describes the
// wait when status is not connected, yet it passed neither actionLabel nor
// onAction. EmptyState already renders a button when both are set, and
// retryAutoConnect is already in scope (LastErrorBanner and the no-gateway
// ChatEmptyState use it). Offer Reconnect on that variant only.
function readTranscriptEmpty(): string {
  const src = readChatScreen();
  const match = src.match(/<EmptyState[\s\S]*?"Waiting for connection"[\s\S]*?\/>/);
  expect(match).not.toBeNull();
  return match![0];
}

describe('Bot Chat waiting-for-connection empty state', () => {
  test('the Waiting-for-connection empty state offers Reconnect wired to retryAutoConnect', () => {
    const empty = readTranscriptEmpty();
    expect(empty).toMatch(/actionLabel="Reconnect"/);
    expect(empty).toMatch(/onAction=\{[\s\S]*?void retryAutoConnect\(\)[\s\S]*?\}/);
  });

  test('Reconnect is offered only while status is not connected', () => {
    // The waiting state is its own branch now: a connected empty thread renders
    // the welcome instead, so this EmptyState only ever draws disconnected.
    const src = readChatScreen();
    expect(src).toMatch(/\) : status === 'connected' \? \([\s\S]*?<ThreadWelcome[\s\S]*?\) : \([\s\S]*?"Waiting for connection"/);
    const empty = readTranscriptEmpty();
    expect(empty).toContain('actionLabel="Reconnect"');
    expect(empty).toContain('onAction={() => void retryAutoConnect()}');
  });

  test('the Waiting-for-connection title and description stay plain', () => {
    const empty = readTranscriptEmpty();
    expect(empty).toContain('title="Waiting for connection"');
    expect(empty).toContain('description="The chat goes live as soon as the gateway connects."');
  });

  test('a connected empty thread offers starters that fill the composer, never send', () => {
    const src = readChatScreen();
    const welcome = src.match(/<ThreadWelcome[\s\S]*?\/>/)?.[0] ?? '';
    expect(welcome).toContain('onPick={setDraft}');
    expect(src).not.toContain('Type /help to explore your gateway');
  });

  test('EmptyState renders the action only when both actionLabel and onAction are set', () => {
    const src = readSource(['src', 'components', 'ui', 'EmptyState.tsx']);
    expect(src).toMatch(/actionLabel\?: string;/);
    expect(src).toMatch(/onAction\?: \(\) => void;/);
    expect(src).toContain('{actionLabel && onAction ? (');
  });

  test('the no-gateway ChatEmptyState still wires onConnect to retryAutoConnect', () => {
    const src = readChatScreen();
    expect(src).toContain('onConnect={() => void retryAutoConnect()}');
  });

  test('the group-room empty state keeps its Back-to-the-roster action untouched', () => {
    const src = readChatScreen();
    const match = src.match(/<EmptyState[\s\S]*?'This room is gone'[\s\S]*?\/>/);
    expect(match).not.toBeNull();
    expect(match![0]).toContain('actionLabel="Back to the roster"');
    expect(match![0]).toContain('onAction={() => showSurface({ kind: \'roster\' })}');
  });
});
