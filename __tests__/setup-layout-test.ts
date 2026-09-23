// ─── Gate setup layout ─────────────────────────────────────────────────────
// The setup screen shares Settings' content gutters and rhythm, carries one
// screen title in its own body (the card headings sit at headline level, like
// every Settings card), and each tab's intro caption is grouped with the
// section it describes instead of floating under the tabs. Pinned off the
// source so a restyle that drops the padding, re-promotes the card heading,
// or detaches an intro fails here, not on the phone.

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

const setup = () => readSource('src', 'app', 'gateway', 'setup.tsx');

test('setup content sits in the same gutters and rhythm as Settings', () => {
  const src = setup();
  const contentBlock = src.match(/content:\s*\{[^}]*\}/);
  expect(contentBlock).not.toBeNull();
  expect(contentBlock?.[0]).toContain('padding: Spacing.four');
  expect(contentBlock?.[0]).toContain('gap: Spacing.three');
});

test('the chat backend card heading is a headline, not a second screen title', () => {
  const src = setup();
  expect(src).toContain('<Text variant="headline">Chat backend</Text>');
  expect(src).not.toContain('<Text variant="title">Chat backend</Text>');
});

test('the screen body carries exactly one title-level heading', () => {
  const src = setup();
  const titles = src.match(/variant="title"/g) ?? [];
  expect(titles).toHaveLength(1);
  expect(src).toContain('<Text variant="title">Gate setup</Text>');
});

test('each tab intro is grouped in a panel with the section it describes', () => {
  const src = setup();
  const panels = [
    ['Model providers the Gate owns', 'ProvidersSection'],
    ['CLI agents attached to this Gate', 'EnvironmentsSection'],
    ['Instances of non-provider capability kinds', 'CapabilitiesSection'],
    ['Saved gateways, auto-connect, and local discovery', 'GatewayManagementSection'],
    ['Push notifications from this Gate', 'NotificationsSection'],
  ] as const;
  for (const [intro, sectionName] of panels) {
    const panel = src.match(
      new RegExp(
        `<View style=\\{styles\\.panel\\}>[\\s\\S]*?${intro}[\\s\\S]*?<${sectionName}[\\s\\S]*?</View>`,
      ),
    );
    expect(panel).not.toBeNull();
  }
});

test('panel grouping is tighter than the gap between panels', () => {
  const src = setup();
  const panelStyle = src.match(/panel:\s*\{[^}]*\}/);
  expect(panelStyle).not.toBeNull();
  expect(panelStyle?.[0]).toMatch(/gap:\s*Spacing\.(one|two)/);
  const contentBlock = src.match(/content:\s*\{[^}]*\}/);
  expect(contentBlock?.[0]).toContain('gap: Spacing.three');
});

test('tab wiring, backend semantics, and section mounts stay untouched', () => {
  const src = setup();
  expect(src).toContain('SegmentedControl');
  expect(src).toContain('selectedBackendId');
  expect(src).toContain('const activeBackendId = selectedBackendId;');
  expect(src).toContain('ProvidersSection');
  expect(src).toContain('EnvironmentsSection');
  expect(src).toContain('CapabilitiesSection');
  expect(src).toContain('GatewayManagementSection');
  expect(src).toContain('NotificationsSection');
  expect(src).toContain('ToolsetsSection');
  expect(src).toContain('RpcMethodsSection');
  expect(src).toContain('GatewayIdentitySection');
  expect(src).toContain('backendChipLabel');
});
