declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readProviderSource(): string {
  // gateway-provider.tsx is CRLF on disk; normalize so the block regexes
  // below do not depend on the file's line endings.
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'context', 'gateway-provider.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

function readChatScreenSource(): string {
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'components', 'chat', 'chat-screen.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

describe('chat surface context split', () => {
  test('the three streaming-scoped states render in a nested provider inside GatewayProvider', () => {
    const src = readProviderSource();
    expect(src).toMatch(
      /const ChatSurfaceContext = createContext<ChatSurfaceContextValue \| null>\(null\);/,
    );
    // children sits inside the nested provider, which sits inside the outer
    // one, so every tab still receives GatewayContext.
    const ret = src.match(
      /return \(\s*<GatewayContext\.Provider value=\{value\}>\s*<ChatSurfaceContext\.Provider value=\{chatSurfaceValue}>\s*\{children}\s*<\/ChatSurfaceContext\.Provider>\s*<\/GatewayContext\.Provider>\s*\);/,
    );
    expect(ret).toBeDefined();
  });

  test('the outer value memo no longer lists messages, isSending or isCommandRunning', () => {
    const src = readProviderSource();
    const block = src.match(/const value = useMemo<GatewayContextValue>\([\s\S]*?\n  \);/)?.[0];
    expect(block).toBeDefined();
    expect(block).not.toMatch(/\bmessages\b/);
    expect(block).not.toMatch(/\bisSending\b/);
    expect(block).not.toMatch(/\bisCommandRunning\b/);
    // The three states live in their own memo feeding the nested provider,
    // churn included, so a streamed frame no longer touches the outer value.
    const surface = src.match(
      /const chatSurfaceValue = useMemo<ChatSurfaceContextValue>\([\s\S]*?\[messages, isSending, isCommandRunning\],\n  \);/,
    );
    expect(surface).toBeDefined();
  });

  test('sendMessage reads the latest transcript through a ref so its identity does not churn per streamed frame', () => {
    // sendMessage feeds sendChatInput, which is in the outer memo deps — if
    // its identity churned with `messages`, the split would be pointless.
    const src = readProviderSource();
    const send = src.match(/const sendMessage = useCallback\([\s\S]*?\n    \],\n  \);/)?.[0];
    expect(send).toBeDefined();
    expect(send).toMatch(/messagesRef\.current/);
    expect(send).not.toMatch(/\bmessages\b/);
  });

  test('useChatSurface is exported and chat-screen reads the three states off it', () => {
    const src = readProviderSource();
    expect(src).toMatch(/export function useChatSurface\(\)/);
    const screen = readChatScreenSource();
    expect(screen).toMatch(
      /import \{ useChatSurface, useGateway \} from '@\/context\/gateway-provider';/,
    );
    expect(screen).toMatch(/const \{ messages, isSending, isCommandRunning \} = useChatSurface\(\);/);
    const outer = screen.match(/const \{\n[\s\S]*?\} = useGateway\(\);/)?.[0];
    expect(outer).toBeDefined();
    expect(outer).not.toMatch(/\bmessages\b/);
    expect(outer).not.toMatch(/\bisSending\b/);
    expect(outer).not.toMatch(/\bisCommandRunning\b/);
  });
});