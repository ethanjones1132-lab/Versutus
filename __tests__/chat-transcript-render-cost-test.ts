declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(relative: string): string {
  return nodeFs.readFileSync([__dirname, '..', 'src', relative].join(SEP), 'utf8');
}

describe('chat transcript streaming render cost', () => {
  test('MessageBubble is exported wrapped in memo so unchanged bubbles skip re-render', () => {
    const bubble = readSource('components/chat/message-bubble.tsx');
    expect(bubble).toMatch(/export const MessageBubble = memo\(/);
    expect(bubble).not.toMatch(/export function MessageBubble/);
  });

  test('renderMessage keeps a stable identity: no messages dep, no divider work inside', () => {
    const screen = readSource('components/chat/chat-screen.tsx');
    const block = screen.match(/const renderMessage = useCallback\([\s\S]*?\],\n\s*\);/)?.[0];
    expect(block).toBeDefined();
    expect(block).not.toMatch(/\bmessages\b/);
    expect(block).not.toMatch(/formatDayDivider/);
  });

  test('day dividers are decided once per message change, outside renderItem', () => {
    const screen = readSource('components/chat/chat-screen.tsx');
    expect(screen).toMatch(/const transcriptItems = useMemo<TranscriptItem\[\]>\(/);
    expect(screen).toMatch(/const transcriptItems = useMemo<TranscriptItem\[\]>\([\s\S]*?formatDayDivider/);
    expect(screen).toMatch(/showDivider/);
    // The FlatList is fed the decorated items, so renderItem never sees
    // the raw message array.
    expect(screen).toMatch(/data=\{transcriptItems\}/);
    expect(screen).toMatch(/keyExtractor=\{\(item\) => item\.message\.id\}/);
  });

  test('the transcript FlatList bounds what it mounts and renders', () => {
    const screen = readSource('components/chat/chat-screen.tsx');
    const list = screen.match(/<FlatList[\s\S]*?renderItem=\{renderMessage\}/)?.[0];
    expect(list).toBeDefined();
    expect(list).toMatch(/removeClippedSubviews/);
    expect(list).toMatch(/windowSize=\{\d+\}/);
    expect(list).toMatch(/maxToRenderPerBatch=\{\d+\}/);
  });
});