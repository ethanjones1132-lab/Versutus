import {
  BOT_CHAT_TITLE,
  botChipModelPin,
  botChipRoutingTag,
  botRowSubtitle,
  buildRoster,
  ensureBotChat,
  filterRosterRows,
  findBotChat,
  isBotChat,
  loadBotChat,
  rosterEmptyView,
  type ChatSurface,
  type PublicBot,
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

test('botChipModelPin shows the pinned default and stays silent without one', () => {
  expect(
    botChipModelPin({
      id: 'researcher',
      displayName: 'researcher',
      routable: true,
      model: { default: 'anthropic/claude-sonnet-4', provider: 'kilo' },
    }),
  ).toBe('anthropic/claude-sonnet-4');
  // Older Gates report no pins at all; unpinned and provider-only stay silent.
  expect(botChipModelPin({ id: 'a', displayName: 'a', routable: true })).toBe('');
  expect(botChipModelPin({ id: 'b', displayName: 'b', routable: true, model: null })).toBe('');
  expect(
    botChipModelPin({ id: 'c', displayName: 'c', routable: true, model: { default: null, provider: 'kilo' } }),
  ).toBe('');
  // A whitespace-only pin from the Gate must not render an empty pill segment.
  expect(
    botChipModelPin({ id: 'd', displayName: 'd', routable: true, model: { default: '   ', provider: null } }),
  ).toBe('');
});

test('every member chip resolves its pin across a full six-member room', () => {
  // Max-size room (6 members). The view resolves each chip's pin by mapping
  // memberIds over the roster exactly like this, so every chip must get a
  // defined string — '' means silent, never undefined rendered into a Text.
  const memberIds = ['a', 'b', 'c', 'd', 'e', 'f'];
  const members: PublicBot[] = [
    { id: 'a', displayName: 'A', routable: true, model: { default: 'm-a', provider: null } },
    { id: 'b', displayName: 'B', routable: true },
    { id: 'c', displayName: 'C', routable: true, model: null },
    { id: 'd', displayName: 'D', routable: true, model: { default: null, provider: 'kilo' } },
    { id: 'e', displayName: 'E', routable: true, model: { default: '  m-e  ', provider: null } },
    { id: 'f', displayName: 'F', routable: false },
  ];
  const byId = new Map(members.map((bot) => [bot.id, botChipModelPin(bot)]));
  const pins = memberIds.map((id) => byId.get(id) ?? '');
  expect(pins).toHaveLength(6);
  expect(pins.every((pin) => typeof pin === 'string')).toBe(true);
  // Only the two pinned members show a pin, displayed trimmed.
  expect(pins.filter((pin) => pin)).toEqual(['m-a', 'm-e']);
});

test('botChipRoutingTag names the routing cause or stays silent', () => {
  // Routable members render silence — never an empty pill segment.
  expect(botChipRoutingTag({ id: 'a', displayName: 'a', routable: true })).toBe('');
  expect(botChipRoutingTag({ id: 'b', displayName: 'b', routable: true, routingIssue: null })).toBe('');
  // No key at all and a refused default key are different fixes, so they
  // stay the same two verdict words the roster row uses.
  expect(botChipRoutingTag({ id: 'c', displayName: 'c', routable: false })).toBe('No listen key');
  expect(
    botChipRoutingTag({ id: 'd', displayName: 'd', routable: true, routingIssue: 'listen_key_missing' }),
  ).toBe('No listen key');
  expect(
    botChipRoutingTag({ id: 'e', displayName: 'e', routable: true, routingIssue: 'default_key_refused' }),
  ).toBe('Default listen key refused');
});

test('routing tag outranks the model pin on a member chip', () => {
  // Exactly what the view resolves per chip: a member carrying a routing
  // issue shows the tag INSTEAD of its model pin — the operator reads why
  // the round will come back short, not what a silent bot is pinned to.
  const members: PublicBot[] = [
    {
      id: 'echo',
      displayName: 'Echo',
      routable: true,
      routingIssue: 'default_key_refused',
      model: { default: 'anthropic/claude-sonnet-4', provider: null },
    },
    { id: 'live', displayName: 'Live', routable: true, model: { default: 'm-live', provider: null } },
    { id: 'mute', displayName: 'Mute', routable: false, model: { default: 'm-mute', provider: null } },
  ];
  const chips = members.map((bot) => {
    const tag = botChipRoutingTag(bot);
    return { id: bot.id, tag, pin: tag ? '' : botChipModelPin(bot) };
  });
  expect(chips[0]).toEqual({ id: 'echo', tag: 'Default listen key refused', pin: '' });
  expect(chips[1]).toEqual({ id: 'live', tag: '', pin: 'm-live' });
  expect(chips[2]).toEqual({ id: 'mute', tag: 'No listen key', pin: '' });
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

test('rosterEmptyView claims zero bots only when the inventory truly answered empty', () => {
  expect(
    rosterEmptyView({ totalBotRows: 0, visibleBotRows: 0, visibleGroups: 0, query: '' }),
  ).toEqual({ kind: 'zero-bots' });
  // A FAILED inventory is not "zero bots" — the phone does not know what the
  // host has. The failure names itself and carries the reason verbatim.
  expect(
    rosterEmptyView({
      totalBotRows: 0,
      visibleBotRows: 0,
      visibleGroups: 0,
      query: '',
      error: 'hermes: An internal server error has occurred',
    }),
  ).toEqual({ kind: 'load-failed', reason: 'hermes: An internal server error has occurred' });
});

test('rosterEmptyView never calls a group match "no match"', () => {
  // The operator can see a matched room right below the banner — claiming no
  // agents match while a room row renders would contradict the screen.
  expect(
    rosterEmptyView({
      totalBotRows: 3,
      visibleBotRows: 0,
      visibleGroups: 1,
      query: 'research',
    }),
  ).toEqual({ kind: 'none' });
  // With rooms present but unmatched too, the banner is honest again.
  expect(
    rosterEmptyView({
      totalBotRows: 3,
      visibleBotRows: 0,
      visibleGroups: 0,
      query: '  nomatch  ',
    }),
  ).toEqual({ kind: 'no-match', query: 'nomatch' });
});

test('rosterEmptyView stays silent for blank queries and visible bots', () => {
  // Nothing was filtered, so nothing can have failed to match.
  expect(
    rosterEmptyView({ totalBotRows: 3, visibleBotRows: 3, visibleGroups: 2, query: '' }),
  ).toEqual({ kind: 'none' });
  expect(
    rosterEmptyView({ totalBotRows: 1, visibleBotRows: 1, visibleGroups: 0, query: '   ' }),
  ).toEqual({ kind: 'none' });
});

test('rosterEmptyView keeps stale rows silent even while an error is reported', () => {
  // A refresh error with rows still on screen must not swap the footer for a
  // failure card over live data — the caption line carries the reason.
  expect(
    rosterEmptyView({
      totalBotRows: 2,
      visibleBotRows: 2,
      visibleGroups: 0,
      query: '',
      error: 'gateway unreachable',
    }),
  ).toEqual({ kind: 'none' });
});

test('multiplex off is its own verdict on the row and the chip', () => {
  // Two things are wrong at once when a profile copied the default key on a
  // host with multiplex off, and only one of them is worth telling the
  // operator first: /p/<name>/ is not an address at all there, so a distinct
  // key alone fixes nothing.
  const bot: PublicBot = {
    id: 'anvil',
    displayName: 'anvil',
    routable: false,
    routingIssue: 'multiplex_disabled',
  };
  expect(botRowSubtitle(bot)).toBe('Multiplex is off');
  expect(botChipRoutingTag(bot)).toBe('Multiplex is off');
  // Same precedence as the other issues: a reported verdict beats a stale
  // `routable: true` from an older Gate.
  expect(botRowSubtitle({ ...bot, routable: true })).toBe('Multiplex is off');
  expect(botChipRoutingTag({ ...bot, routable: true })).toBe('Multiplex is off');
});
