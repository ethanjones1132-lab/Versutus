declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(): string {
  return nodeFs.readFileSync(
    [__dirname, '..', 'src', 'components', 'gateway', 'gateway-home-dashboard.tsx'].join(SEP),
    'utf8',
  );
}

describe('home dashboard derived values are memoized', () => {
  test('useMemo is imported from react', () => {
    // The dashboard re-derived its gateway list, run filter, capability count,
    // channel glance and runs-supported flag on every render — including each
    // streamed frame — even though those inputs rarely change mid-turn.
    const src = readSource();
    expect(src).toMatch(/import \{ useMemo, useState \} from 'react'/);
  });

  test('activeRuns is inside a useMemo keyed on activityRuns', () => {
    // The run filter (.filter) rebuilt a fresh array every frame; memoize it so
    // a streamed chunk that only touched messages skips the filter.
    const src = readSource();
    expect(src).not.toMatch(/const activeRuns = activityRuns\.filter/);
    expect(src).toMatch(/const activeRuns = useMemo\([\s\S]*?\[activityRuns\]/);
  });

  test('capabilityCount is inside a useMemo keyed on capabilitySnapshot.groups', () => {
    // The capability tally (.filter().length) ran every frame; memoize it on the
    // groups array, which is stable while a turn streams.
    const src = readSource();
    expect(src).not.toMatch(/const capabilityCount = capabilitySnapshot\.groups\.filter/);
    expect(src).toMatch(/const capabilityCount = useMemo\([\s\S]*?\[capabilitySnapshot\.groups\]/);
  });

  test('channelGroup and runsSupported are also memoized on capabilitySnapshot.groups', () => {
    // Same class as capabilityCount: a .find over the groups array per frame.
    const src = readSource();
    expect(src).not.toMatch(/const channelGroup = capabilitySnapshot\.groups\.find/);
    expect(src).toMatch(/const channelGroup = useMemo\([\s\S]*?\[capabilitySnapshot\.groups\]/);
    expect(src).not.toMatch(/const runsSupported =\n\s*connected && capabilitySnapshot\.groups\.find/);
    expect(src).toMatch(/const runsSupported = useMemo\([\s\S]*?capabilitySnapshot\.groups/);
  });
});
