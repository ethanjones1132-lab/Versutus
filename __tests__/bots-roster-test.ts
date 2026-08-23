import {
  BOT_CHAT_TITLE,
  botRowSubtitle,
  buildRoster,
  ensureBotChat,
  filterRosterRows,
  findBotChat,
  isBotChat,
  loadBotChat,
  type ChatSurface,
  type RosterRow,
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

test('unroutable subtitles name the cause: missing key vs refused default key', () => {
  expect(
    botRowSubtitle({
      id: 'silent',
      displayName: 'silent',
      routable: false,
      routingIssue: 'listen_key_missing',
    }),
  ).toBe('No listen key');
  // A copied default listen key is a DIFFERENT fix (set a distinct one), so it
  // must not hide behind the generic "no key" line.
  expect(
    botRowSubtitle({
      id: 'echo',
      displayName: 'echo',
      routable: false,
      routingIssue: 'default_key_refused',
      model: { default: 'anthropic/claude-sonnet-4', provider: null },
    }),
  ).toBe('Default listen key refused');
});

test('routingIssue wins over a stale routable boolean, older Gates degrade', () => {
  expect(
    botRowSubtitle({ id: 'e', displayName: 'e', routable: true, routingIssue: 'default_key_refused' }),
  ).toBe('Default listen key refused');
  expect(botRowSubtitle({ id: 'x', displayName: 'x', routable: false })).toBe('No listen key');
});

test('filterRosterRows keeps navigation rows and ignores blank queries', () => {
  const rows: RosterRow[] = buildRoster([
    { id: 'researcher', displayName: 'Researcher', routable: true },
    { id: 'coder', displayName: 'Coder', routable: true },
  ]);
  expect(filterRosterRows(rows, '')).toEqual(rows);
  expect(filterRosterRows(rows, '   ')).toEqual(rows);
  const filtered = filterRosterRows(rows, 'cod');
  expect(filtered).toHaveLength(2); // configurable row + Coder
  expect(filtered[0].kind).toBe('configurable');
  expect(filtered.some((row) => row.kind === 'bot' && row.bot.id === 'coder')).toBe(true);
});

test('filterRosterRows matches name, id, and description case-insensitively', () => {
  const rows: RosterRow[] = buildRoster([
    { id: 'researcher', displayName: 'Deep Diver', routable: true, description: 'Runs long research' },
    { id: 'coder', displayName: 'Pilot', routable: true },
    { id: 'scout', displayName: 'Scout', routable: false, routingIssue: 'default_key_refused' },
  ]);
  const byDescription = filterRosterRows(rows, 'LONG RESEARCH');
  expect(byDescription.map((row) => (row.kind === 'bot' ? row.bot.id : row.kind))).toContain('researcher');
  expect(byDescription).toHaveLength(2);
  const byId = filterRosterRows(rows, 'SCOUT');
  expect(byId).toHaveLength(2);
  const byName = filterRosterRows(rows, 'diver');
  expect(byName).toHaveLength(2);
  expect(filterRosterRows(rows, 'nomatch')).toHaveLength(1); // only the Chat row
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
