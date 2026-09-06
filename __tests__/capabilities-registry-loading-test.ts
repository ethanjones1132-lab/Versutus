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

  test('the empty copy renders only after the read lands, byte-identical', () => {
    // A genuinely empty registry after the read must read exactly as
    // before; the flag gates the branch, never the copy.
    const src = readSectionSource();
    expect(src).toMatch(/\) : instances\.length === 0 \? \(/);
    expect(src).toMatch(/No instances yet\./);
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
