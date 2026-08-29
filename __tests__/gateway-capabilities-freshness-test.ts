declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(): string {
  return nodeFs.readFileSync(
    [__dirname, '..', 'src', 'components', 'gateway', 'gateway-capabilities.tsx'].join(SEP),
    'utf8',
  );
}

describe('gateway capabilities freshness tick scope', () => {
  test('the per-minute clock no longer lives in GatewayCapabilities', () => {
    // The whole card — every CapabilityPill plus the header — re-rendered each
    // minute purely to bump staleMinutes, the "Xm ago" stamp. The clock must be
    // gone from the parent so the pill grid renders only when groups/checkedAt
    // actually change.
    const src = readSource();
    expect(src).not.toMatch(/const \[now, setNow\]/);
    expect(src).not.toMatch(/setInterval\(\(\) => setNow\(Date\.now\(\)\), 60_000\)/);
  });

  test('the staleness stamp is rendered by a dedicated CapabilityFreshness child that owns the tick', () => {
    // Mirrors the LiveElapsed / FreshnessLabel extraction: the parent stays
    // still between checks; only the label re-renders for the clock.
    const src = readSource();
    expect(src).toMatch(/function CapabilityFreshness/);
    const uses = [...src.matchAll(/useNow\(/g)];
    expect(uses).toHaveLength(1);
    // useNow must appear inside CapabilityFreshness, not at the GatewayCapabilities top level.
    expect(src.slice(0, uses[0].index)).toMatch(/function CapabilityFreshness/);
  });

  test('the parent hands checkedAt and status to CapabilityFreshness rather than ticking itself', () => {
    const src = readSource();
    expect(src).toMatch(/<CapabilityFreshness checkedAt=\{checkedAt\} status=\{snapStatus\} ?\/>/);
    // The parent no longer feeds its own clock into the stamp; the child does.
    expect(src).not.toMatch(/snapStatus\} • \{staleMinutes\}m ago/);
  });
});
