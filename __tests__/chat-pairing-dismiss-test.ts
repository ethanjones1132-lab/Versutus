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

function readChatScreen(): string {
  return readSource(['src', 'components', 'chat', 'chat-screen.tsx']);
}

function readPairingSheet(): string {
  return readSource(['src', 'components', 'chat', 'pairing-sheet.tsx']);
}

function readHomeDashboard(): string {
  return readSource(['src', 'components', 'gateway', 'gateway-home-dashboard.tsx']);
}

function extractPairingSheetMount(src: string): string {
  const start = src.indexOf('<PairingSheet');
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('/>', start);
  expect(end).toBeGreaterThan(-1);
  return src.slice(start, end + 2);
}

function extractPairingBanner(src: string): string {
  const start = src.indexOf('<PairingRequiredBanner');
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('/>', start);
  expect(end).toBeGreaterThan(-1);
  return src.slice(start, end + 2);
}

// Dismissing PairingSheet stamped dismissedPairingKey so the sheet never
// remounted, while Home only renders PairingPanel on the unsaved-gateways
// empty path. After dismiss, Chat must still offer a way back to the same
// pairing panel while status stays pairing.
describe('Bot Chat dismissed pairing still offers a way back', () => {
  test('Dismiss still hides the sheet by stamping the pairing key', () => {
    const mount = extractPairingSheetMount(readChatScreen());
    expect(mount).toContain('visible={showPairingSheet}');
    expect(mount).toContain('onDismiss={() => setDismissedPairingKey(pairingKey)}');
    expect(readChatScreen()).toContain(
      "const showPairingSheet = status === 'pairing' && !!deviceId && dismissedPairingKey !== pairingKey;",
    );
  });

  test('the pairing sheet still offers Dismiss and does not trap the operator', () => {
    const src = readPairingSheet();
    expect(src).toContain('closeLabel="Dismiss"');
    expect(src).toContain('onClose={onDismiss}');
    expect(src).toContain('<PairingPanel deviceId={deviceId} pairingDetails={pairingDetails} />');
  });

  test('after dismiss, a pairing-required banner reopens the same sheet', () => {
    const src = readChatScreen();
    expect(src).toContain(
      "const showPairingBanner = status === 'pairing' && !!deviceId && dismissedPairingKey === pairingKey;",
    );
    const banner = extractPairingBanner(src);
    expect(src).toMatch(
      /\{showPairingBanner \? \(\s*<PairingRequiredBanner onShow=\{\(\) => setDismissedPairingKey\(null\)\} \/>/,
    );
    expect(banner).toContain('onShow={() => setDismissedPairingKey(null)}');
  });

  test('the banner copy names pairing and offers Show pairing code', () => {
    const src = readChatScreen();
    const helperStart = src.indexOf('function PairingRequiredBanner');
    expect(helperStart).toBeGreaterThan(-1);
    const helperEnd = src.indexOf('export function ChatScreen', helperStart);
    const helper = src.slice(helperStart, helperEnd);
    expect(helper).toContain('Pairing required');
    expect(helper).toContain('Approve this phone on your PC to finish connecting.');
    expect(helper).toContain('label="Show pairing code"');
    expect(helper).toContain('onPress={onShow}');
  });

  test("Home's unsaved-gateways PairingPanel stays byte-identical", () => {
    const src = readHomeDashboard();
    expect(src).toContain('if (gateways.length === 0) {');
    expect(src).toContain('{model.showPairing && deviceId ? (');
    expect(src).toContain('<PairingPanel deviceId={deviceId} pairingDetails={pairingDetails} />');
    // Exactly one PairingPanel on Home: the unsaved empty path. The saved-
    // gateway branch names pairing with a Badge, not the approve panel.
    expect(src.match(/<PairingPanel /g)?.length).toBe(1);
  });

  test('the saved-gateway Home branch still names pairing with a non-pressable Badge', () => {
    const src = readHomeDashboard();
    expect(src).toContain("status === 'pairing'");
    expect(src).toContain("? 'Needs approval'");
    expect(src).toContain(
      "<Badge label={statusLabel} tone={connected ? 'success' : status === 'pairing' ? 'accent' : 'neutral'} />",
    );
    // The Badge is not wrapped in a pressable that would open pairing.
    const badgeIdx = src.indexOf('<Badge label={statusLabel}');
    expect(badgeIdx).toBeGreaterThan(-1);
    const around = src.slice(badgeIdx - 80, badgeIdx);
    expect(around).not.toMatch(/PressableScale|onPress/);
  });
});
