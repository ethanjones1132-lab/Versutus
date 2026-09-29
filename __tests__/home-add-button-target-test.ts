declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readGatewayHomeDashboardSource(): string {
  return nodeFs.readFileSync(
    [__dirname, '..', 'src', 'components', 'gateway', 'gateway-home-dashboard.tsx'].join(SEP),
    'utf8',
  );
}

test('home Gateways Add button meets the 44dp touch target', () => {
  const header = nodeFs.readFileSync(
    [__dirname, '..', 'src', 'components', 'ui', 'SectionHeader.tsx'].join(SEP),
    'utf8',
  );
  expect(header).toContain('style={styles.action}');
  expect(header).toMatch(/action:\s*\{[^}]*minHeight:\s*44/);
});

test('the section-header action opens Add gateway', () => {
  const src = readGatewayHomeDashboardSource();
  expect(src).toContain('actionLabel="Add gateway"');
  expect(src).toContain("onAction={() => router.push('/gateway/add')}");
});
