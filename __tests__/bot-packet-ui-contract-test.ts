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

describe('the Bot handoff packet wiring', () => {
  test('the detail sheet carries an Export row composed from the pure packet fold', () => {
    const src = readSource('src', 'components', 'chat', 'bot-detail-sheet.tsx');
    expect(src).toContain('onExportPacket');
    // The row exists with the manifest copy beside it — the trust line is
    // rendered by the sheet, not only carried in the file.
    expect(src).toContain('Export handoff packet');
    expect(src).toContain('botPacketManifest(buildBotPacket(bot, soulState))');
    // The row only renders with a handler; no button without an offer.
    expect(src).toContain('{onExportPacket ? (');
  });

  test('the chat screen composes buildBotPacket with the one share seam, fire-and-forget', () => {
    const src = readSource('src', 'components', 'chat', 'chat-screen.tsx');
    // The sheet gets an export offer on a real Bot.
    expect(src).toContain('onExportPacket=');
    // The three packet symbols are used at the handler — writing the packet
    // shares takes the seam, never a second implementation.
    expect(src).toContain('buildBotPacket(detailBot, soulState)');
    expect(src).toContain('botPacketFileName(detailBot)');
    expect(src).toContain('JSON.stringify(packet');
    expect(src).toContain('shareBotPacketFile(');
    // Fire-and-forget: a refused share can never read as a refused open of
    // the sheet, and nothing awaits the platform.
    expect(src).toMatch(/void shareBotPacketFile/);
  });

  test("the detail sheet's earlier rows keep working — the export lives beside them", () => {
    const src = readSource('src', 'components', 'chat', 'bot-detail-sheet.tsx');
    // The pre-existing rows stay untouched in shape: Edit agent and Copy
    // profile id are still the sheet's actions, with the export row between
    // copy and edit — no row removed, none replaced.
    expect(src).toContain('title="Edit agent"');
    expect(src).toContain('title="Copy profile id"');
  });
});

describe("the approval-policy editor's UI wiring (D1's editing surface)", () => {
  test('the chat screen hands the store seams to the detail sheet, with a real Bot', () => {
    const src = readSource('src', 'components', 'chat', 'chat-screen.tsx');
    // The store's write finally gains its caller — and through the sheet's
    // own props, never a second write path invented in the screen.
    expect(src).toContain('onLoadApprovalPolicy={');
    expect(src).toContain('onSaveApprovalPolicy={');
    expect(src).toContain('loadBotApprovalPolicy');
    expect(src).toContain('setBotApprovalPolicy(detailBot.id, policy)');
    expect(src).toContain("from '@/lib/settings/bot-approval-policy'");
  });

  test('the sheet composes the save from the pure draft fold, not its own parsing', () => {
    const src = readSource('src', 'components', 'chat', 'bot-detail-sheet.tsx');
    // The editor states the copy that belongs to the policy — the honest
    // framing, rendered, not only carried in a type import.
    expect(src).toContain('APPROVAL_POLICY_LIMIT_COPY');
    expect(src).toContain('approvalPolicyDraft(draftText, draftEnabled)');
    expect(src).toContain('APPROVAL POLICY');
    // The section is armed only with both seams — read-only sheet otherwise.
    expect(src).toContain('if (!onLoad || !onSave) return null');
    // The section rides inside the existing ScrollView, beside the rows.
    expect(src).toContain('<ApprovalPolicySection');
  });
});
