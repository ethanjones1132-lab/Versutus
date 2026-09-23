declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSectionSource(): string {
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'components', 'gateway', 'capabilities-section.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

describe('capabilities registry loading', () => {
  test('the pre-first-read window holds layout with skeletons instead of the empty copy', () => {
    // The section mounts with kinds=[] and instances=[] before the
    // deferred first read lands; that window flashed "No instances yet."
    // plus an Add card with zero buttons. It now renders placeholder rows
    // in both cards until the read lands.
    const src = readSectionSource();
    expect(src).toMatch(/const \[loaded, setLoaded\] = useState\(false\)/);
    expect(src).toMatch(/\!loaded && \!error \? \(/);
    const skeletons = src.match(/<Skeleton width="90%" height=\{44\} \/>/g) ?? [];
    expect(skeletons).toHaveLength(2);
  });

  test('the empty copy renders only after a clean read lands, byte-identical', () => {
    // A genuinely empty registry after the read must read exactly as
    // before; the flag and a non-error state gate the branch, never the
    // copy — a refused read sets error and loaded together, so an
    // ungated empty branch would claim the registry is empty on failure.
    const src = readSectionSource();
    expect(src).toMatch(/\) : instances\.length === 0 && !error \? \(/);
    expect(src).not.toMatch(/\) : instances\.length === 0 \? \(/);
    expect(src).toMatch(/No instances yet\./);
  });

  test('a refused or disconnected read never claims the registry is empty', () => {
    // catch and the disconnected path both set error and loaded=true, so
    // the Configured card must not fall through to the empty copy when
    // error is set — the refusal caption above is the only claim then.
    const src = readSectionSource();
    expect(src).toMatch(/setError\(/);
    const emptyBranch = src.match(
      /\) : instances\.length === 0 && !error \? \([\s\S]*?\) : /,
    )?.[0];
    expect(emptyBranch).toBeDefined();
    expect(emptyBranch).toMatch(/No instances yet\./);
    // no ungated path into the empty copy survives
    expect(src).not.toMatch(/instances\.length === 0 \? \s*<Text[^>]*>\s*No instances yet/);
  });

  test('the Add card is never a heading-only card', () => {
    // Under error (or a clean read with zero kinds) the Add card used to
    // render only its "Add" headline — kinds stayed empty and no line
    // explained why. It now names the unavailable/no-kinds state.
    const src = readSectionSource();
    expect(src).toMatch(/\) : kinds\.length === 0 \? \(/);
    const noKinds = src.match(/\) : kinds\.length === 0 \? \([\s\S]*?\) : \(/)?.[0];
    expect(noKinds).toBeDefined();
    expect(noKinds).toMatch(/<Text variant="caption"/);
    expect(noKinds).toMatch(/Capability kinds unavailable\./);
    expect(noKinds).toMatch(/No capability kinds to add\./);
  });

  test('both read outcomes mark the first read landed, so errors never strand skeletons', () => {
    // A refused first read flips the flag too, so the error caption +
    // Retry path shows instead of skeletons standing forever.
    const src = readSectionSource();
    const marks = src.match(/setLoaded\(true\)/g) ?? [];
    expect(marks.length).toBeGreaterThanOrEqual(3);
  });

  test('the failed-read error caption and Retry path are byte-identical', () => {
    // The change adds a loading affordance above the list; it must not
    // restyle or reword the refusal itself or its retry.
    const src = readSectionSource();
    expect(src).toMatch(/<Text variant="caption" color="statusDisconnected" selectable>/);
    expect(src).toMatch(/kinds\.length === 0 && instances\.length === 0 && !draft \? \(/);
    expect(src).toMatch(/label="Retry"/);
    expect(src).toMatch(/onPress=\{\(\) => void load\(\)\}/);
  });
});
