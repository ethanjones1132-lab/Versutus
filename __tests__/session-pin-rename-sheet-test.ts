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

const sheet = () => readSource('src', 'components', 'chat', 'thread-config-sheet.tsx');

// P3's pin/rename surface (`FUTURE-ITEMS.md:523-531`): the selector sorts a
// pinned session to the top and names it with the operator's own name. The
// store and the folds are pinned in session-labels-test.ts; these are the
// wiring pins — that the ordering runs BEFORE the search narrows the list,
// that the row prints the name and the badge, and that the rename copy never
// claims the gateway renamed anything.
describe('the session selector reads the label store', () => {
  test('the pinned-first ordering runs before the search narrows the list', () => {
    const src = sheet();
    const orderedAt = src.indexOf('orderSessionsByLabel(sessions,');
    const filteredAt = src.indexOf('filterSessions(');
    expect(orderedAt).toBeGreaterThan(-1);
    expect(filteredAt).toBeGreaterThan(-1);
    // A search that ran first would sort the matches back into read order.
    expect(orderedAt).toBeLessThan(filteredAt);
    expect(src).toContain('filterSessions(ordered, query)');
  });

  test('the row is printed through the operator-name rule, not the gateway title alone', () => {
    const src = sheet();
    expect(src).toContain('sessionLabelTitle(item.title, label)');
    // The store is read once per open, and the write goes through its folds.
    expect(src.match(/loadSessionLabels\(\)/g)).toHaveLength(1);
    expect(src).toMatch(/applySessionLabel\(labels, sessionLabelKey\(gatewayId, /);
    expect(src).toMatch(/void saveSessionLabels\(next\)/);
  });

  test('a pinned row carries a Pinned badge and the row offers Pin and Rename', () => {
    const src = sheet();
    // The badge sits beside the shipped Current badge on the same row.
    expect(src).toMatch(
      /<Badge label="Current" tone="accent" dot=\{false\} \/>[\s\S]{0,400}?<Badge label="Pinned"/,
    );
    expect(src).toMatch(/accessibilityLabel=\{`\$\{pinned \? 'Unpin' : 'Pin'\} session /);
    expect(src).toMatch(/accessibilityLabel=\{`Rename session /);
  });

  test('the pin and rename controls appear only where a label can be keyed', () => {
    const src = sheet();
    // No gateway id, no `sessionLabelKey`, so no control that cannot finish.
    expect(src).toContain('{gatewayId ? (');
    const gateAt = src.indexOf('{gatewayId ? (');
    const pinAt = src.indexOf("? 'Unpin' : 'Pin'");
    const renameAt = src.indexOf('`Rename session ');
    expect(pinAt).toBeGreaterThan(gateAt);
    expect(renameAt).toBeGreaterThan(gateAt);
  });

  test("the rename copy says the name is this device's, never the gateway's", () => {
    const src = sheet();
    expect(src).toContain('Kept on this device');
    expect(src).not.toMatch(/renamed on the gateway|gateway renamed|renamed the session on/i);
  });

  test('the shipped selector surfaces are untouched', () => {
    const src = sheet();
    // Window line, delete rule, Bot Chat badge, and the list the taps ride on.
    expect(src).toContain('sessionListWindowCopy(sessions.length)');
    expect(src).toContain('onDeleteSession && !isCurrent');
    expect(src).toContain('const botChatBadge = sessionBotChatBadge(item);');
    expect(src).toContain('data={visibleSessions}');
  });
});

describe('the chat screen hands the selector the gateway its labels are keyed by', () => {
  const screen = () => readSource('src', 'components', 'chat', 'chat-screen.tsx');

  test('ThreadConfigSheet is given the active gateway id', () => {
    const src = screen();
    expect(src).toContain('gatewayId={activeGateway.id}');
  });

  // The title rule names TWO surfaces — `sessionListTitle`'s own doc says it is
  // "What the selector and header print for a session" — so the header is the
  // rule's second caller rather than a surface with a rule of its own. These
  // pins hold the header to the fold the row prints.
  test('the header label is folded through the operator-name rule', () => {
    const src = screen();
    expect(src).toContain("from '@/lib/gateway/session-labels'");
    expect(src).toMatch(/sessionLabelTitle\(\s*currentSession\?\.title,/);
    // The bare gateway-title rule no longer reaches the header, so the two
    // surfaces cannot disagree about one thread.
    expect(src).not.toContain('sessionListTitle');
  });

  test('the header looks the name up under the active gateway, as the sheet does', () => {
    const src = screen();
    expect(src).toContain('sessionLabelKey(activeGateway.id, currentSessionId)');
    expect(src).toMatch(/const sessionLabel = currentSessionId[\s\S]{0,240}?sessionLabels\[/);
  });

  test('the screen reads the label blob on the way back from the sheet', () => {
    const src = screen();
    // One read site, hanging off the sheet's own visibility flag, writing one
    // state: the name is never fetched and never re-derived from a send.
    expect(src.match(/loadSessionLabels\(\)/g)).toHaveLength(1);
    const gateAt = src.indexOf('if (sessionSelector.visible) return;');
    expect(gateAt).toBeGreaterThan(-1);
    expect(src.indexOf('loadSessionLabels()')).toBeGreaterThan(gateAt);
    expect(src).toContain('}, [sessionSelector.visible]);');
  });

  test("the selector's own call site is unchanged", () => {
    const src = sheet();
    expect(src).toContain('sessionLabelTitle(item.title, label)');
    // Still the sheet's own blob read: the header reads the same store, it
    // never writes it.
    expect(src.match(/loadSessionLabels\(\)/g)).toHaveLength(1);
  });
});
