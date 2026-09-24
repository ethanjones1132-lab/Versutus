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

function provider(): string {
  return readSource('src', 'context', 'gateway-provider.tsx');
}

function settings(): string {
  return readSource('src', 'app', 'gateway', 'settings.tsx');
}

/** A window around the provider's deviceId state declaration. */
function readDeviceStateWindow(): string {
  const src = provider();
  const at = src.indexOf('const [deviceId, setDeviceId] = useState<string | null>(null);');
  expect(at).toBeGreaterThanOrEqual(0);
  return src.slice(at, at + 1600);
}

/** The This-device card, from its headline to the end of its Card. */
function readDeviceCard(): string {
  const src = settings();
  const start = src.indexOf('>This device</Text>');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = src.indexOf('</Card>', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

/** The bootstrap's identity read, sliced generously. */
function readBootstrapIdentityRead(): string {
  const src = provider();
  const at = src.indexOf('Device identity powers pairing/access requests');
  expect(at).toBeGreaterThanOrEqual(0);
  return src.slice(at, at + 400);
}

// The bootstrap fired loadOrCreateDeviceIdentity().then(setDeviceId).catch(() => undefined),
// so a SecureStore/keystore refusal left deviceId null for the session and the
// This-device card rendered "Loading device identity…" forever — a settled
// failure presented as an in-progress read with no retry. The provider now
// keeps the cause and offers a re-read; the card names the refusal.
describe('gateway settings names a failed device identity read', () => {
  test('the provider tracks the identity read as loading, ready, or failed beside deviceId', () => {
    const window = readDeviceStateWindow();
    expect(window).toContain("useState<'loading' | 'ready' | 'failed'>('loading')");
    expect(window).toContain('deviceIdState');
    expect(window).toContain('deviceIdError');
  });

  test('a refusal settles failed with the caught message, not just a null', () => {
    const src = provider();
    const readAt = src.indexOf('const readDeviceIdentity = useCallback(');
    expect(readAt).toBeGreaterThanOrEqual(0);
    const readBody = src.slice(readAt, readAt + 700);
    expect(readBody).toContain('loadOrCreateDeviceIdentity');
    expect(readBody).toContain('ok: false');
    expect(readBody).toMatch(/caught instanceof Error \? caught\.message : String\(caught\)/);

    const applyAt = src.indexOf('const applyDeviceIdentityRead = useCallback(');
    expect(applyAt).toBeGreaterThanOrEqual(0);
    const applyBody = src.slice(applyAt, applyAt + 700);
    expect(applyBody).toContain("setDeviceIdState('failed')");
    expect(applyBody).toContain('setDeviceIdError(');
    expect(applyBody).toContain("setDeviceIdState('ready')");
  });

  test('the bootstrap read settles through the same settler instead of a swallowing catch', () => {
    const window = readBootstrapIdentityRead();
    expect(window).toContain('readDeviceIdentity().then(applyDeviceIdentityRead)');
    expect(window).not.toContain('.catch(() => undefined)');
  });

  test('the refusal and a re-read are exposed on the gateway context', () => {
    const src = provider();
    expect(src).toContain("deviceIdState: 'loading' | 'ready' | 'failed';");
    expect(src).toContain('deviceIdError: string | null;');
    expect(src).toContain('reloadDeviceId: () => void;');

    const valueAt = src.indexOf('const value = useMemo<GatewayContextValue>(');
    expect(valueAt).toBeGreaterThanOrEqual(0);
    const valueWindow = src.slice(valueAt, valueAt + 1200);
    expect(valueWindow).toContain('deviceIdState');
    expect(valueWindow).toContain('deviceIdError');
    expect(valueWindow).toContain('reloadDeviceId');
  });

  test('the Retry flips back to loading and re-issues the read through the settler', () => {
    const window = readDeviceStateWindow();
    const retryAt = window.indexOf('const reloadDeviceId = useCallback(');
    expect(retryAt).toBeGreaterThanOrEqual(0);
    const retryBody = window.slice(retryAt, retryAt + 500);
    expect(retryBody).toContain("setDeviceIdState('loading')");
    expect(retryBody).toContain('setDeviceIdError(null)');
    expect(retryBody).toContain('readDeviceIdentity');
    expect(retryBody).toContain('applyDeviceIdentityRead');
  });

  test('the This-device card draws an ErrorCard with a Retry when the read failed', () => {
    const card = readDeviceCard();
    expect(card).toContain("deviceIdState === 'failed'");
    expect(card).toContain('<ErrorCard');
    expect(card).toContain('deviceIdError');
    expect(card).toContain('onRetry={reloadDeviceId}');
  });

  test('the failed branch leads the loading caption', () => {
    const card = readDeviceCard();
    const failedAt = card.indexOf("deviceIdState === 'failed'");
    const loadingAt = card.indexOf('Loading device identity…');
    expect(failedAt).toBeGreaterThanOrEqual(0);
    expect(loadingAt).toBeGreaterThan(failedAt);
  });

  test('the screen reads the new context fields beside deviceId', () => {
    const src = settings();
    expect(src).toMatch(
      /const \{[^}]*deviceIdState[^}]*deviceIdError[^}]*reloadDeviceId[^}]*\}\s*=\s*\n?\s*useGateway\(\);/,
    );
  });
});

describe('gateway settings keeps the device identity card working', () => {
  test('a settled id still renders through DeviceIdRow ahead of the failure branch', () => {
    const card = readDeviceCard();
    const rowAt = card.indexOf('<DeviceIdRow deviceId={deviceId}');
    const failedAt = card.indexOf("deviceIdState === 'failed'");
    expect(rowAt).toBeGreaterThanOrEqual(0);
    expect(failedAt).toBeGreaterThan(rowAt);
  });

  test('the loading fallback copy stays byte-identical', () => {
    expect(settings()).toContain('Loading device identity…');
  });

  test('the private-key micro copy stays byte-identical', () => {
    expect(settings()).toContain(
      'Used for gateway pairing and access requests. The private key remains in secure storage.',
    );
  });

  test('the private key itself is never rendered', () => {
    const src = settings();
    expect(src).not.toContain('{privateKey}');
    expect(src).not.toContain('settings.privateKey');
  });
});
