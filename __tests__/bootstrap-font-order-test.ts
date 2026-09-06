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

function readLayoutSource(): string {
  return readSource(['src', 'app', '_layout.tsx']);
}

test('the gateway provider mounts outside the font gate so bootstrap runs during font load', () => {
  const src = readLayoutSource();
  const gatewayOpen = src.indexOf('<GatewayProvider>');
  const fontOpen = src.indexOf('<FontProvider>');
  expect(gatewayOpen).toBeGreaterThanOrEqual(0);
  expect(fontOpen).toBeGreaterThanOrEqual(0);
  // The provider ancestor mounts first: its bootstrap effect (storage reads
  // + auto-connect) fires while useFonts is still resolving instead of after.
  expect(gatewayOpen).toBeLessThan(fontOpen);
  const gatewayClose = src.indexOf('</GatewayProvider>');
  const fontClose = src.indexOf('</FontProvider>');
  expect(fontClose).toBeLessThan(gatewayClose);
});

test('the native splash still hides only on font resolution', () => {
  const src = readSource(['src', 'components', 'font-provider.tsx']);
  // FontProvider still withholds its children until the fonts land.
  expect(src).toContain('if (!loaded && !error)');
  expect(src).toContain('return children;');
  // And the splash hides on the same loaded-or-error signal as today.
  expect(src).toContain('if (loaded || error)');
  expect(src).toContain('SplashScreen.hideAsync()');
});

test('the boot overlay still gates the stack on bootstrap exactly as today', () => {
  const src = readSource(['src', 'components', 'app-bootstrap.tsx']);
  expect(src).toContain('if (!isBootstrapped)');
  expect(src).toContain('Starting Versutus…');
  expect(src).toContain('return children;');
});
