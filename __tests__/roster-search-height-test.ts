declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readRosterSearchBody(): string {
  const src = nodeFs.readFileSync(
    [__dirname, '..', 'src', 'components', 'chat', 'chat-roster.tsx'].join(SEP),
    'utf8',
  );
  const m = src.match(/search:\s*\{([^}]+)\}/);
  if (!m) throw new Error('search style not found in chat-roster.tsx');
  return m[1];
}

test('roster search field meets 48dp touch target', () => {
  const body = readRosterSearchBody();
  const minHeightMatch = body.match(/minHeight:\s*(\d+)/);
  expect(minHeightMatch).not.toBeNull();
  const minHeight = Number(minHeightMatch![1]);
  expect(minHeight).toBeGreaterThanOrEqual(48);
  expect(body).not.toMatch(/minHeight:\s*0\b/);
});

test('roster search field does not crush vertical padding below kit default', () => {
  const body = readRosterSearchBody();
  const pvMatch = body.match(/paddingVertical:\s*(\d+)/);
  if (pvMatch) {
    expect(Number(pvMatch[1])).toBeGreaterThanOrEqual(12);
  } else {
    expect(true).toBe(true);
  }
});
