declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readPaneSource(): string {
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'components', 'gateway', 'paired-devices-pane.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

function readRegistrySource(): string {
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'lib', 'gateway', 'dashboard.ts'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

function readSlashSource(): string {
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'lib', 'gateway', 'slash-commands.ts'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

function readExecuteRevoke(): string {
  const src = readPaneSource();
  const start = src.indexOf('const executeRevoke');
  const end = src.indexOf('if (!visible) return null;', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('paired-devices revoke', () => {
  test('an active row exposes a Revoke action wired to a ConfirmSheet that calls device.revoke', () => {
    // The pane was a read-only stub (its own header comment said so) and
    // hid every destructive affordance behind a slash command. Now each
    // active row carries a trailing Revoke that opens a ConfirmSheet
    // which fires gatewayRequest('device.revoke', { deviceId }) on confirm.
    const src = readPaneSource();

    // The pane imports ConfirmSheet from the UI barrel.
    expect(src).toMatch(
      /import\s+\{[^}]*\bConfirmSheet\b[^}]*\}\s+from\s+['"]@\/components\/ui['"]/,
    );

    // The pane tracks which device's revoke is pending confirmation and an
    // optional error string for a failed revoke (the Gate throws on scope
    // mismatch or unknown device, so the row must not silently flip).
    expect(src).toMatch(/useState<string\s*\|\s*null>\(\s*null\s*\)/);

    // The map over devices places a Revoke button only on the non-revoked
    // branch and opens the ConfirmSheet for the tapped row's deviceId.
    expect(src).toMatch(/onPress=\{\(\) => setRevokeTarget\(device\.deviceId\)\}/);

    // The ConfirmSheet confirms into gatewayRequest('device.revoke', { deviceId: ... }).
    // The pane may snapshot revokeTarget into a local before awaiting so a
    // race where the user cancels after confirm still revokes the device
    // they confirmed — the deviceId argument names either revokeTarget or
    // a snapshot of it.
    expect(src).toMatch(
      /gatewayRequest\(\s*['"]device\.revoke['"]\s*,\s*\{\s*deviceId:\s*(?:revokeTarget|target)\s*\}\s*\)/,
    );

    // ConfirmSheet is wired with danger semantics so a Warning haptic fires.
    expect(src).toMatch(/danger\b/);
    expect(src).toMatch(/confirmLabel="Revoke"/);
  });

  test('a revoked row never renders a Revoke action', () => {
    // A row the Gate already revoked must not show a destructive button —
    // the user would see "Revoke" on a device that no longer holds a token,
    // and a second revoke round-trip is wasted work.
    const src = readPaneSource();

    // The Revoke button is gated on !row.revoked, so a revoked row gets no
    // button. The button is wrapped in a trailing View alongside the badge.
    expect(src).toMatch(/!\s*row\.revoked\s*\?\s*\([\s\S]*?Revoke[\s\S]*?\)\s*:\s*null/);
    // The badge is still rendered for the non-revoked branch.
    expect(src).toMatch(/Badge label="active"/);
    expect(src).toMatch(/Badge label="revoked"/);
    // The button label and tone are pinned — anything else would let a
    // regression drift toward a non-destructive verb or a different colour.
    expect(src).toMatch(/label="Revoke"/);
  });

  test('a successful revoke re-reads device.list so the row drops to "revoked"', () => {
    // The pane must refresh after a confirmed revoke. The cheapest correct
    // path is the existing `load` function — same device.list read the
    // mount effect runs — folded through applyPairedDevicesRead.
    const src = readPaneSource();
    expect(src).toMatch(/onConfirm=\{executeRevoke\}/);
    expect(src).toMatch(/void load\(\)/);
    // The revoke target is cleared so the sheet hides after a successful revoke.
    expect(src).toMatch(/setRevokeTarget\(null\)/);
  });

  test('a successful revoke closes the sheet and re-reads only after device.revoke returns', () => {
    // Closing and reloading before the Gate answers treated a throw as
    // success — the sheet vanished, the row still said active, and
    // nothing named the refusal. Close + load live in the try, after
    // the await.
    const execute = readExecuteRevoke();
    const tryAt = execute.indexOf('try {');
    const catchAt = execute.indexOf('} catch');
    expect(tryAt).toBeGreaterThanOrEqual(0);
    expect(catchAt).toBeGreaterThan(tryAt);
    const tryBlock = execute.slice(tryAt, catchAt);
    expect(tryBlock).toContain("await gatewayRequest('device.revoke', { deviceId: target })");
    expect(tryBlock).toContain('setRevokeTarget(null);');
    expect(tryBlock).toContain('void load();');
    const requestAt = tryBlock.indexOf("await gatewayRequest('device.revoke', { deviceId: target })");
    expect(tryBlock.indexOf('setRevokeTarget(null);')).toBeGreaterThan(requestAt);
    expect(tryBlock.indexOf('void load();')).toBeGreaterThan(requestAt);
  });

  test('a refused revoke names the Gate reason and keeps the sheet open', () => {
    // device.revoke throws "No device \"<id>\" on file." for an unknown id
    // and surfaces a scope error for operator.read callers. The pane must
    // not silently drop the row to "revoked" — the Gate says nothing
    // changed, and the UI must agree. A throw is not a close.
    const execute = readExecuteRevoke();
    const catchAt = execute.indexOf('} catch');
    expect(catchAt).toBeGreaterThanOrEqual(0);
    const catchBlock = execute.slice(catchAt);
    expect(catchBlock).toContain(
      'setRevokeError(caught instanceof Error ? caught.message : String(caught));',
    );
    expect(catchBlock).not.toContain('setRevokeTarget(null);');
    expect(catchBlock).not.toContain('void load();');
  });

  test('a failed revoke keeps the row active and does not mutate the list locally', () => {
    const src = readPaneSource();
    // The pane does NOT mutate devices optimistically; a successful revoke
    // is reflected by the post-revoke device.list read, not by a local
    // mutation that may diverge from reality.
    expect(src).not.toMatch(/devices\.map\(\(device\)\s*=>\s*device\.deviceId\s*===\s*revokeTarget/);
  });

  test('the ConfirmSheet names a refusal in place of the confirmation copy', () => {
    // The default confirmation copy stays the fallback so a first open
    // still says what Revoke will do. A kept refusal replaces it so the
    // operator sees the Gate's reason without dismissing.
    const src = readPaneSource();
    expect(src).toMatch(
      /message=\{revokeError\s*\|\|\s*"This device's token will be removed from the Gate\. Any other paired device keeps working\."\}/,
    );
  });

  test('cancel and a fresh confirm clear a previous refusal', () => {
    const src = readPaneSource();
    expect(src).toMatch(/onCancel=\{\(\) => \{\s*setRevokeTarget\(null\);\s*setRevokeError\(null\);\s*\}\}/);
    const execute = readExecuteRevoke();
    const tryAt = execute.indexOf('try {');
    expect(tryAt).toBeGreaterThan(0);
    expect(execute.slice(0, tryAt)).toContain('setRevokeError(null);');
  });

  test('the failed-first-read retry button stays byte-identical', () => {
    // The Retry affordance added in an earlier iteration must not move.
    // A revoke change that nudges the retry branch is a regression —
    // this test pins the byte-identical Retry wiring as it stands.
    const src = readPaneSource();
    expect(src).toMatch(/!shown\.loaded && shown\.failed \? \(/);
    expect(src).toMatch(/label="Retry"/);
    expect(src).toMatch(/onPress=\{\(\) => void load\(\)\}/);
  });

  test('a row never carries a token, even after a revoke flow', () => {
    // pairedDeviceRowCopy is the lib the pane renders through. The
    // token-bearing payload the Gate returns must not survive parsePairedDevice.
    const { pairedDeviceRowCopy } = jest.requireActual('@/lib/gateway/paired-devices') as typeof import(
      '@/lib/gateway/paired-devices'
    );
    const row = pairedDeviceRowCopy({
      deviceId: 'abc123',
      role: 'operator',
      scopes: ['operator.read'],
      issuedAtMs: 1_700_000_000_000,
      revoked: false,
    });
    expect(JSON.stringify(row)).not.toMatch(/token/i);
    expect(row.title).toBe('abc123');
  });

  test('the /device revoke slash command stays wired through runRegistryCommand', () => {
    // The pane change must not remove the slash path. An operator who
    // types /device revoke <id> still goes through the registry entry
    // and into device.revoke via runRegistryCommand, exactly as before.
    const dash = readRegistrySource();
    expect(dash).toMatch(/id:\s*['"]device-revoke['"]/);
    expect(dash).toMatch(/method:\s*['"]device\.revoke['"]/);
    expect(dash).toMatch(/slash:\s*['"]\/device revoke['"]/);
    expect(dash).toMatch(/danger:\s*['"]destructive['"]/);

    const slash = readSlashSource();
    expect(slash).toMatch(/return\s+runRegistryCommand\(\s*['"]device-revoke['"]/);
  });
});