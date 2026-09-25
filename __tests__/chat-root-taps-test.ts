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

const readChatScreen = () => readSource(['src', 'components', 'chat', 'chat-screen.tsx']);
const readChatHeader = () => readSource(['src', 'components', 'chat', 'chat-header.tsx']);
const readOverflow = () => readSource(['src', 'components', 'chat', 'chat-overflow-sheet.tsx']);
const readChatRoster = () => readSource(['src', 'components', 'chat', 'chat-roster.tsx']);
const readEmpty = () => readSource(['src', 'components', 'chat', 'chat-empty-state.tsx']);
const readEmptyIos = () => readSource(['src', 'components', 'chat', 'chat-empty-state.ios.tsx']);
const readActivity = () => readSource(['src', 'app', '(tabs)', 'activity.tsx']);
const readHome = () => readSource(['src', 'app', '(tabs)', 'home.tsx']);
const readRootLand = () => readSource(['src', 'app', '(tabs)', 'index.tsx']);

/**
 * Contract test for the ≤3-taps audit pass (CHARTER priority 3, tab IA):
 * every non-negotiable action from the Chat root — Bot Chat, model,
 * sessions, pending approvals, settings entry, connect gateway — is a tap
 * path on Chat/Activity chrome itself. Settings was the one path that still
 * forced a Home detour (Home's trailing gear was its only door); Chat now
 * carries its own settings entries in the header's one menu and in the
 * not-connected empty, while the Home gear stays as the residual's own entry.
 */
describe('Every high-value action is ≤3 taps from the Chat root', () => {
  test('the cold-start root still lands on the Chat roster', () => {
    const src = readRootLand();
    expect(src).toContain('<Redirect');
    expect(src).toContain('href="/chat"');
  });

  test('Bot Chat opens from a roster row — one tap', () => {
    const roster = readChatRoster();
    expect(roster).toContain('onPress={onSelectConfigurable}');
    expect(roster).toContain('onPress={rosterBotTap(row.bot, {');
    const screen = readChatScreen();
    expect(screen).toContain('onSelectBot={(bot) => {');
    expect(screen).toContain('onSelectConfigurable={() => {');
  });

  test('the model is the header subtitle and sessions sit in the header menu', () => {
    const header = readChatHeader();
    // The one-row header draws the model as its tappable subtitle — that is
    // the only control left beside back and the menu.
    expect(header).toContain('onPress={onModelPress}');
    const screen = readChatScreen();
    expect(screen).toContain('onModelPress={threadSurface ? handleHeaderModelPress : undefined}');
    // Sessions left the header row for the menu: from a thread, menu → Sessions
    // is two taps and no chip has to share the title's width.
    const sheet = screen.match(/<ChatOverflowSheet[\s\S]*?\/>/)?.[0];
    expect(sheet).toBeDefined();
    expect(sheet).toContain(
      'onSessionsPress={threadSurface ? handleHeaderSessionPress : undefined}',
    );
    const overflow = readOverflow();
    expect(overflow).toContain('title="Sessions"');
    expect(overflow).toContain('onSessionsPress();');
  });

  test('pending approvals are one Activity tab away, listed at its top', () => {
    const src = readActivity();
    expect(src).toContain('<ApprovalInbox />');
  });

  test('connect gateway is the not-connected Chat empty CTA', () => {
    const src = readChatScreen();
    expect(src).toContain('onConnect={() => void retryAutoConnect()}');
  });

  test('Chat chrome carries its own settings entries — no Home detour', () => {
    // The one-row header holds no gear: settings is a row in the one menu it
    // does hold, so the Chat root still opens settings in two taps.
    const overflow = readOverflow();
    expect(overflow).toContain('onSettingsPress?: () => void;');
    expect(overflow).toContain('title="Settings"');
    expect(overflow).toContain("ios: 'gearshape', android: 'settings', web: 'settings'");
    expect(overflow).toContain('onSettingsPress();');
    expect(overflow).not.toContain('Palette.gold');
    // The header itself stays gear-free chrome.
    expect(readChatHeader()).not.toContain('gearshape');

    const screen = readChatScreen();
    // Menu door: stable callback pushing settings directly.
    expect(screen).toContain('const handleHeaderSettingsPress = useCallback(() => {');
    expect(screen).toContain("router.push('/gateway/settings');");
    expect(screen).toContain('onSettingsPress={handleHeaderSettingsPress}');
    // Empty-state door: the disconnected Chat root never needs Home either.
    expect(screen).toContain('onSettings={() => router.push(\'/gateway/settings\')}');
    // Neither door routes through /home first.
    expect(screen).not.toMatch(/onSettings[^=]*=\{[^}]*\/home/);

    for (const src of [readEmpty(), readEmptyIos()]) {
      expect(src).toContain('onSettings?: () => void;');
      expect(src).toContain('<Button label="Settings" variant="ghost" onPress={onSettings} />');
    }
    // The existing Connect + Go to Home CTAs stay byte-identical.
    const empty = readEmpty();
    expect(empty).toContain('<Button label="Connect to gateway" onPress={onConnect} />');
    expect(empty).toContain('<Button label="Go to Home" variant="ghost" onPress={onGoHome} />');
  });

  test('the demoted Home residual keeps its own settings gear too', () => {
    const src = readHome();
    expect(src).toContain("onTrailingPress={() => router.push('/gateway/settings')}");
  });
});
