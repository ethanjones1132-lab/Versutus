declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readGroupRoomViewSource(): string {
  // group-room-view.tsx is CRLF on disk; normalize so the block regexes
  // below do not depend on the file's line endings.
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'components', 'chat', 'group-room-view.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

describe('group room round in-flight feedback', () => {
  test('the transcript tail shows the streaming indicator while a round runs', () => {
    // A round's replies land only when the whole round resolves — minutes
    // later for a six-bot room — so the tail must say the bots are at work
    // instead of freezing silently (chat thread idiom, message-bubble.tsx:275).
    const src = readGroupRoomViewSource();
    expect(src).toMatch(
      /import \{ StreamingIndicator \} from '@\/components\/chat\/streaming-indicator'/,
    );
    const footer = src.match(/ListFooterComponent=\{\s*sending \? \([\s\S]*?\) : null\}/)?.[0];
    expect(footer).toBeDefined();
    expect(footer).toContain('<StreamingIndicator />');
    expect(footer).toContain('Bots are answering');
  });

  test('the in-flight row lives on the transcript list, not outside it', () => {
    // The footer is part of the FlatList content, so the send-time
    // scrollToBottom reaches it and the row rides the transcript's scroll.
    const src = readGroupRoomViewSource();
    const list = src.match(/\n      <FlatList[\s\S]*?\n      \/>/)?.[0];
    expect(list).toBeDefined();
    const footer = list?.match(/ListFooterComponent=\{\s*sending \? \([\s\S]*?\) : null\}/)?.[0];
    expect(footer).toBeDefined();
    expect(footer).toContain('StreamingIndicator');
  });
});