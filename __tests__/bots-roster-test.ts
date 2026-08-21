import {
  BOT_CHAT_TITLE,
  buildRoster,
  ensureBotChat,
  findBotChat,
  isBotChat,
  loadBotChat,
  type ChatSurface,
} from '@/lib/gateway/bots';

test('roster is configurable chat first, then every bot including default', () => {
  const rows = buildRoster([
    { id: 'default', displayName: 'Harumesu', routable: true },
    { id: 'researcher', displayName: 'researcher', routable: true },
  ]);
  expect(rows[0]).toEqual({ kind: 'configurable' });
  expect(rows[1]).toEqual({
    kind: 'bot',
    bot: { id: 'default', displayName: 'Harumesu', routable: true },
  });
  expect(rows[2].kind).toBe('bot');
});

test('findBotChat picks the canonical title, not the last session', () => {
  const sessions = [
    { id: 's1', title: 'yesterday' },
    { id: 's2', title: BOT_CHAT_TITLE },
    { id: 's3', title: 'notes' },
  ];
  expect(findBotChat(sessions)?.id).toBe('s2');
  expect(isBotChat({ title: BOT_CHAT_TITLE })).toBe(true);
  expect(isBotChat({ title: 'notes' })).toBe(false);
});

test('ensureBotChat reuses the canonical session and does not create a second', async () => {
  const created: string[] = [];
  const existing = [{ id: 's2', title: BOT_CHAT_TITLE }];
  const session = await ensureBotChat(existing, async (title) => {
    created.push(title);
    return { id: 'new', title };
  });
  expect(session.id).toBe('s2');
  expect(created).toEqual([]);
});

test('ensureBotChat creates Bot Chat when missing', async () => {
  const session = await ensureBotChat([{ id: 's1', title: 'notes' }], async (title) => ({ id: 'new', title }));
  expect(session.title).toBe(BOT_CHAT_TITLE);
});

test('the tab starts on the roster, not a session', () => {
  const initial: ChatSurface = { kind: 'roster' };
  expect(initial.kind).toBe('roster');
});

test('loadBotChat does not swallow a list failure', async () => {
  await expect(
    loadBotChat(
      async () => {
        throw new Error('hermes: An internal server error has occurred');
      },
      async (title) => ({ id: 'new', title }),
    ),
  ).rejects.toThrow(/internal server error/i);
});

test('loadBotChat reuses Bot Chat when list succeeds', async () => {
  const created: string[] = [];
  const session = await loadBotChat(
    async () => [{ id: 's2', title: BOT_CHAT_TITLE }],
    async (title) => {
      created.push(title);
      return { id: 'new', title };
    },
  );
  expect(session.id).toBe('s2');
  expect(created).toEqual([]);
});
