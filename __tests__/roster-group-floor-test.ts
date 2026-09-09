declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(...segments: string[]): string {
  // Components under test are CRLF on disk; normalize so the block regexes
  // below do not depend on the file's line endings.
  return nodeFs
    .readFileSync([__dirname, '..', ...segments].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

function readChatRosterSource(): string {
  return readSource('src', 'components', 'chat', 'chat-roster.tsx');
}

function readCreateGroupSheetSource(): string {
  return readSource('src', 'components', 'chat', 'create-group-sheet.tsx');
}

function readGroupsSource(): string {
  return readSource('src', 'lib', 'gateway', 'groups.ts');
}

describe('roster New Group Room under the two-bot floor', () => {
  test('the row renders whenever onNewGroup is set, with no member-count gate', () => {
    // Under the floor the row vanished, so the honest floor copy inside the
    // sheet could never be seen. The row now shows whenever the gateway can
    // host rooms; the sheet itself names the floor and refuses Create.
    const src = readChatRosterSource();
    expect(src).toMatch(/\{onNewGroup \? \(/);
    expect(src).not.toMatch(/onNewGroup && routableBots/);
    expect(src).not.toMatch(/onNewGroup &&[^\n]*MIN_GROUP_MEMBERS/);
  });

  test('the row is still hidden entirely when onNewGroup is absent', () => {
    // Gateways that cannot host rooms keep the honest capability note instead
    // of a row that would refuse after the sheet was filled.
    const src = readChatRosterSource();
    const rowBlock = src.match(/\{onNewGroup \? \([\s\S]*?\) : null\}/)?.[0];
    expect(rowBlock).toBeDefined();
    expect(rowBlock).toMatch(/title="New Group Room"/);
  });

  test('the row copy is byte-identical', () => {
    const src = readChatRosterSource();
    const rowBlock = src.match(/\{onNewGroup \? \([\s\S]*?\) : null\}/)?.[0];
    expect(rowBlock).toBeDefined();
    expect(rowBlock).toMatch(/subtitle="2–6 bots reply in rounds to one message"/);
    expect(rowBlock).toMatch(/icon=\{\{ ios: 'person\.3', android: 'groups', web: 'groups' \}\}/);
    expect(rowBlock).toMatch(/onPress=\{onNewGroup\}/);
  });

  test('the sheet still names the floor when under it', () => {
    // Opening the row under the floor must hand the operator the sheet's
    // honest verdict, not a dead end.
    const src = readCreateGroupSheetSource();
    const floorBlock = src.match(/\{routable\.length >= MIN_GROUP_MEMBERS \? \([\s\S]*?\) : null\}/)?.[0];
    expect(floorBlock).toBeDefined();
    expect(floorBlock).toMatch(/\{describeGroupCreationFloor\(\{ inventoryLoaded \}\)\}/);
  });

  test('Create is still refused under the floor', () => {
    const sheet = readCreateGroupSheetSource();
    expect(sheet).toMatch(/disabled=\{busy \|\| !validation\.ok\}/);
    const groups = readGroupsSource();
    const validate = groups.match(/export function validateGroup\([\s\S]*?\n\}/)?.[0];
    expect(validate).toBeDefined();
    expect(validate).toMatch(/unique\.length < MIN_GROUP_MEMBERS\)\s*return \{ ok: false, error: 'need at least 2 bots' \}/);
    expect(validate).toMatch(/unique\.length > MAX_GROUP_MEMBERS\)\s*return \{ ok: false, error: 'at most 6 bots' \}/);
  });

  test('onNewGroup is still gated only by connected-and-can-host in chat-screen', () => {
    // The row's presence still means "this gateway can host rooms" — the
    // roster no longer adds its own member-count verdict on top.
    const src = readSource('src', 'components', 'chat', 'chat-screen.tsx');
    expect(src).toMatch(/onNewGroup=\{status === 'connected' && hasGroupRooms/);
  });

  test('the no-rooms capability note is untouched', () => {
    // A gateway that cannot host rooms at all still explains itself where the
    // row would have sat.
    const src = readChatRosterSource();
    expect(src).toMatch(/rosterCapabilityNotes\(\{/);
    expect(src).toMatch(/hasGroupRooms: canHostGroups/);
    const bots = readSource('src', 'lib', 'gateway', 'bots.ts');
    expect(bots).toMatch(/'This gateway does not host group rooms\.'/);
  });
});
