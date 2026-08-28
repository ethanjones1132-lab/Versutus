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

function readHeaderButtonBody(): string {
  const src = readGatewayHomeDashboardSource();
  const m = src.match(/headerButton:\s*\{([^}]+)\}/);
  if (!m) throw new Error('headerButton style not found in gateway-home-dashboard.tsx');
  return m[1];
}

test('home Gateways Add button meets the 44dp touch target', () => {
  // The header Button is md (Button.tsx:66-67 base paddingVertical 13 + body
  // lineHeight 24 = 50dp), but the paddingVertical Spacing.two (8) override
  // crushes it to 8+24+8 = ~40dp (gateway-home-dashboard.tsx:432-436); 40 < 44
  // and Add is the only Add-gateway entry visible on Home.
  const body = readHeaderButtonBody();
  const minHeightMatch = body.match(/minHeight:\s*(\d+)/);
  expect(minHeightMatch).not.toBeNull();
  const minHeight = Number(minHeightMatch![1]);
  expect(minHeight).toBeGreaterThanOrEqual(44);
  expect(body).not.toMatch(/minHeight:\s*0\b/);
});

test('the section-header Add button carries the header button style', () => {
  // Guard the wiring, not just the style block: the Add button opening
  // /gateway/add must be the element the raised target applies to.
  const src = readGatewayHomeDashboardSource();
  expect(src).toMatch(/label="Add"[\s\S]*?style=\{styles\.headerButton\}/);
});