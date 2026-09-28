import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { ChatRoster, type ChatRosterProps } from '@/components/chat/chat-roster';
import { EmptyState } from '@/components/ui';

jest.mock('@/constants/tokens', () => ({
  Radius: { sm: 4, md: 8, lg: 12, pill: 999 },
  Spacing: { one: 4, two: 8, three: 12, four: 16, five: 20 },
}));
jest.mock('@/hooks/use-tokens', () => ({
  useTokens: () => ({
    accent: '#000',
    accentDeep: '#000',
    accentMuted: '#000',
    accentWarm: '#000',
    backgroundElevated: '#000',
    backgroundInset: '#000',
    backgroundRaised: '#000',
    border: '#000',
    statusConnected: '#0f0',
    statusConnecting: '#ff0',
  }),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@/components/chat/bot-avatar', () => ({
  BotAvatar: 'BotAvatar',
  GroupAvatar: 'GroupAvatar',
}));
jest.mock('@/components/connection-badge', () => ({
  PulsingDot: 'PulsingDot',
  statusColor: () => '#000',
}));
jest.mock('@/components/ui', () => ({
  Button: 'Button',
  EmptyState: 'EmptyState',
  Icon: 'Icon',
  PressableScale: 'PressableScale',
  Skeleton: 'Skeleton',
  Text: 'Text',
  TextField: 'TextField',
}));
jest.mock('@/lib/haptics', () => ({ haptics: { impact: jest.fn() } }));

const NAVIGATION_ROW: ChatRosterProps['rows'][number] = { kind: 'configurable' };

async function mount(props: Partial<ChatRosterProps>) {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(ChatRoster, {
        rows: [NAVIGATION_ROW],
        connected: false,
        onSelectConfigurable: jest.fn(),
        onSelectBot: jest.fn(),
        ...props,
      }),
    );
  });
  return renderer;
}

function emptyStateTitles(renderer: ReactTestRenderer): string[] {
  return renderer.root.findAllByType(EmptyState).map((node) => node.props.title as string);
}

describe('the roster admits an unread inventory instead of claiming zero bots', () => {
  let renderer: ReactTestRenderer | undefined;
  afterEach(async () => {
    const current = renderer;
    if (current) await act(async () => { current.unmount(); });
  });

  test('a gateway that never connected waits — the read has not run', async () => {
    renderer = await mount({ connected: false });
    expect(emptyStateTitles(renderer)).toEqual(['Waiting for connection']);
    expect(emptyStateTitles(renderer)).not.toContain('No bots on this gateway');
  });

  test('a completed clean read still claims its honest zero', async () => {
    renderer = await mount({ connected: true, loading: false });
    expect(emptyStateTitles(renderer)).toEqual(['No bots on this gateway']);
  });

  test('a down gateway never contradicts a last-good inventory either', async () => {
    renderer = await mount({
      connected: false,
      rows: [NAVIGATION_ROW, { kind: 'bot', bot: { id: 'scout', displayName: 'Scout', routable: true } }],
    });
    expect(emptyStateTitles(renderer)).toEqual([]);
  });

  test('the waiting state offers no Retry — there is nothing to re-read yet', async () => {
    renderer = await mount({ connected: false });
    const waiting = renderer.root.findAllByType(EmptyState)[0];
    expect(waiting.props.actionLabel).toBeUndefined();
    expect(waiting.props.onAction).toBeUndefined();
  });
});

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

describe('the waiting verdict is wired to the connection, not to luck', () => {
  test('chat-screen hands the roster the same status gate the read itself uses', () => {
    const src = readSource('src', 'components', 'chat', 'chat-screen.tsx');
    const roster = src.match(/<ChatRoster[\s\S]*?\/>/)?.[0];
    expect(roster).toBeDefined();
    expect(roster).toMatch(/connected=\{status === 'connected'\}/);
    // The read above it is gated on the identical condition, so `connected`
    // cannot drift from "the read ran".
    expect(roster).toMatch(/loading=\{rosterLoading && status === 'connected'\}/);
  });

  test('the roster feeds that verdict into the empty-state decision', () => {
    const src = readSource('src', 'components', 'chat', 'chat-roster.tsx');
    const call = src.match(/rosterEmptyView\(\{[\s\S]*?\}\);/)?.[0];
    expect(call).toBeDefined();
    expect(call).toMatch(/connected,/);
    expect(call).not.toMatch(/groupsError/);
  });
});
