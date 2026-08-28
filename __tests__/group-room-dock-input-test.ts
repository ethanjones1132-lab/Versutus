declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readDockInputBody(): string {
  const src = nodeFs.readFileSync(
    [__dirname, '..', 'src', 'components', 'chat', 'group-room-view.tsx'].join(SEP),
    'utf8',
  );
  const m = src.match(/dockInput:\s*\{([^}]+)\}/);
  if (!m) throw new Error('dockInput style not found in group-room-view.tsx');
  return m[1];
}

test('group room dock input meets 48dp touch target', () => {
  const body = readDockInputBody();
  const minHeightMatch = body.match(/minHeight:\s*(\d+)/);
  expect(minHeightMatch).not.toBeNull();
  const minHeight = Number(minHeightMatch![1]);
  expect(minHeight).toBeGreaterThanOrEqual(48);
  expect(body).not.toMatch(/minHeight:\s*0\b/);
});

test('group room dock input keeps flex 1', () => {
  const body = readDockInputBody();
  expect(body).toMatch(/flex:\s*1\b/);
});
