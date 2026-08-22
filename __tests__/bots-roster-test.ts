import {
  BOT_CHAT_TITLE,
  botRowSubtitle,
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

test('botRowSubtitle shows the pinned default model on routable rows', () => {
  expect(
    botRowSubtitle({
      id: 'researcher',
      displayName: 'researcher',
      routable: true,
      model: { default: 'anthropic/claude-sonnet-4', provider: 'kilo' },
    }),
  ).toBe('Bot · anthropic/claude-sonnet-4');
});

test('botRowSubtitle keeps the legacy line when the Gate reports no pin', () => {
  expect(botRowSubtitle({ id: 'a', displayName: 'a', routable: true })).toBe('Bot');
  expect(
    botRowSubtitle({ id: 'b', displayName: 'b', routable: true, description: 'helper', model: null }),
  ).toBe('Bot');
  // Provider-only pin has no default to show — never render a bare separator.
  expect(
    botRowSubtitle({ id: 'c', displayName: 'c', routable: true, model: { default: null, provider: 'kilo' } }),
  ).toBe('Bot');
});

test('botRowSubtitle still flags unroutable bots over any pin', () => {
  expect(
    botRowSubtitle({
      id: 'silent',
      displayName: 'silent',
      routable: false,
      model: { default: 'anthropic/claude-sonnet-4', provider: null },
    }),
  ).toBe('No listen key');
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
