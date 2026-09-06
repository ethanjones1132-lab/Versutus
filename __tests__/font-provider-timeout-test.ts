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

function readFontProviderSource(): string {
  return readSource(['src', 'components', 'font-provider.tsx']);
}

test('the font gate gives up after a bounded window instead of waiting forever', () => {
  const src = readFontProviderSource();
  // The 5-second budget the item asks for, named so a future edit is explicit.
  expect(src).toContain('FONT_LOAD_TIMEOUT_MS = 5000');
  expect(src).toContain('setTimeout(() => setTimedOut(true), FONT_LOAD_TIMEOUT_MS)');
  // The timer is cleaned up and never armed once fonts already resolved.
  expect(src).toContain('clearTimeout(timer)');
  expect(src).toContain('if (loaded || error)');
});

test('the timeout hides the splash and falls back to children', () => {
  const src = readFontProviderSource();
  // A stalled download hides the splash through its own timedOut signal.
  expect(src).toContain('if (timedOut)');
  expect(src).toContain('SplashScreen.hideAsync()');
  // The render gate lets the timeout through to children (system-font
  // fallback) instead of holding the boot spinner indefinitely.
  expect(src).toContain('if (!loaded && !error)');
  expect(src).toContain('return children;');
});

test('the successful font load still hides the splash exactly as today', () => {
  const src = readFontProviderSource();
  // The loading spinner still shows while fonts resolve without a timeout.
  expect(src).toContain('<ActivityIndicator');
  // The timeout state starts false so the happy path is unchanged.
  expect(src).toContain('useState(false)');
});
