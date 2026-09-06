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

function refreshGatewaysBlock(): string {
  const src = readSource(['src', 'context', 'gateway-provider.tsx']);
  const start = src.indexOf('const refreshGateways = useCallback');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = src.indexOf('}, []);', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

test('refreshGateways reads the gateway pair through one Promise.all', () => {
  const block = refreshGatewaysBlock();
  // Both storage reads overlap in a single round instead of two serial
  // SecureStore/AsyncStorage round-trips on every pull-to-refresh.
  expect(block).toContain('Promise.all');
  expect(block).toContain('loadGateways()');
  expect(block).toContain('loadActiveGatewayId()');
});

test('refreshGateways still resolves the active gateway by id with the null fallback', () => {
  const block = refreshGatewaysBlock();
  expect(block).toContain('setGateways(loaded)');
  expect(block).toContain('if (!activeId) return;');
  expect(block).toContain('loaded.find((item) => item.id === activeId) ?? null');
  expect(block).toContain('setActiveGateway(active)');
});
