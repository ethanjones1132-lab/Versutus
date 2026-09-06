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

function readCapabilitiesSource(): string {
  return readSource(['src', 'components', 'gateway', 'gateway-capabilities.tsx']);
}

// The stamp is the Text inside CapabilityFreshness that renders the
// `{status} • {staleMinutes}m ago` copy.
function readStampBlock(): string {
  const src = readCapabilitiesSource();
  const fnStart = src.indexOf('function CapabilityFreshness');
  const copyAt = src.indexOf('}m ago', fnStart);
  const openAt = src.lastIndexOf('<Text', copyAt);
  const closeAt = src.indexOf('>', copyAt);
  return src.slice(openAt, closeAt + 1);
}

test('the freshness stamp renders on the micro type token', () => {
  const stamp = readStampBlock();
  expect(stamp).toMatch(/variant="micro"/);
  expect(stamp).not.toMatch(/fontSize/);
});

test('the stamp keeps the status-ago copy', () => {
  const src = readCapabilitiesSource();
  expect(src).toContain('{status} • {staleMinutes}m ago');
});

test('the per-minute tick stays isolated to the stamp', () => {
  const src = readCapabilitiesSource();
  expect(src).toContain('useNow(60_000');
  // CapabilityFreshness owns the only useNow call; the pill grid and
  // card body must not tick.
  expect(src.match(/useNow\(/g)?.length).toBe(1);
});
