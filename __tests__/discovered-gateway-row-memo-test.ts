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

describe('discovered gateway row memo', () => {
  test('the row imports memo and exports a memoized DiscoveredGatewayRow', () => {
    // Every Gate setup screen tick that does not change `gateway`, `onAdd`,
    // or `isScanning` would otherwise re-run Reanimated's `useSharedValue` +
    // `useAnimatedStyle` for each row in `discovery.gateways.map(...)`.
    // memo stops that, matching the pattern already shipped on
    // `ChatHeader` (chat-header.tsx:35,176), `ChatRoster`
    // (chat-roster.tsx:320), `SkillsPane` (skills-pane.tsx:81),
    // `ToolsPane` (tools-pane.tsx:76), and `RoutinesPane`
    // (routines-pane.tsx:81).
    const src = readSource('src', 'components', 'discovered-gateway-row.tsx');
    expect(src).toMatch(/import \{ memo, useEffect \} from 'react';/);
    expect(src).toMatch(/function DiscoveredGatewayRowImpl\(/);
    expect(src).toMatch(
      /export const DiscoveredGatewayRow = memo\(DiscoveredGatewayRowImpl\);/,
    );
    expect(src).toMatch(/DiscoveredGatewayRow\.displayName = 'DiscoveredGatewayRow';/);
  });

  test('the inner impl no longer exports a bare function', () => {
    // The previous top-level export `function DiscoveredGatewayRow(...)` is
    // gone — otherwise React would happily take the un-memoized version.
    const src = readSource('src', 'components', 'discovered-gateway-row.tsx');
    expect(src).not.toMatch(/export function DiscoveredGatewayRow\(/);
    expect(src).not.toMatch(/export \{ DiscoveredGatewayRowImpl \}/);
  });

  test('the row calls onAdd(gateway.id) instead of bare onAdd()', () => {
    // The signature change is the whole point of the refactor: the row
    // supplies its own id so the parent's callback can stay referentially
    // stable across renders. A bare `onAdd` (no arg) would silently pass
    // `undefined` into the parent's `(gatewayId: string) => void` handler.
    const src = readSource('src', 'components', 'discovered-gateway-row.tsx');
    expect(src).toMatch(/onPress=\{\(\) => onAdd\(gateway\.id\)\}/);
    expect(src).not.toMatch(/onPress=\{onAdd\}/);
    expect(src).toMatch(/onAdd: \(gatewayId: string\) => void;/);
    expect(src).not.toMatch(/onAdd: \(\) => void;/);
  });

  test('the parent passes handleAddDiscovered directly, not an inline closure', () => {
    // `handleAddDiscovered` is `useCallback`'d at
    // `use-gateway-settings-screen.ts:52-66` and is referentially stable
    // across any parent tick that does not change `addGateway`,
    // `connectGateway`, `discovery.gateways`, or `router`. An inline
    // `onAdd={() => void handleAddDiscovered(gateway.id)}` here would defeat
    // memo on its own.
    const src = readSource(
      'src',
      'components',
      'gateway',
      'gateway-management-section.tsx',
    );
    expect(src).toMatch(/onAdd=\{handleAddDiscovered\}/);
    expect(src).not.toMatch(/onAdd=\{\(\) => void handleAddDiscovered\(/);
  });

  test('the gateway-management-section still renders the row inside the .map', () => {
    // Same shape as the other memo pin tests: the parent must keep using
    // `<DiscoveredGatewayRow>` with the same three props the row expects.
    const src = readSource(
      'src',
      'components',
      'gateway',
      'gateway-management-section.tsx',
    );
    expect(src).toMatch(/discovery\.gateways\.map\(\(gateway\) => \(/);
    expect(src).toMatch(/<DiscoveredGatewayRow\b/);
    expect(src).toMatch(/key=\{gateway\.id\}/);
    expect(src).toMatch(/isScanning=\{discovery\.status === 'scanning'\}/);
  });
});