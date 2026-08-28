declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSegmentBody(): string {
  const src = nodeFs.readFileSync(
    [__dirname, '..', 'src', 'components', 'ui', 'SegmentedControl.tsx'].join(SEP),
    'utf8',
  );
  const m = src.match(/segment:\s*\{([^}]+)\}/);
  if (!m) throw new Error('segment style not found in SegmentedControl.tsx');
  return m[1];
}

test('each segmented control segment meets the 44dp touch target', () => {
  // SegmentedControl.tsx:66-80 renders each option as a Pressable with
  // styles.segment (:105-110) -- paddingVertical Spacing.two (8) over caption
  // lineHeight 18 (tokens.ts:101) = ~34dp. It backs the terminal mode picker
  // (mode-picker.tsx:14) and Gate setup (setup.tsx:60), tapped on a phone.
  const body = readSegmentBody();
  const minHeightMatch = body.match(/minHeight:\s*(\d+)/);
  const paddingVerticalMatch = body.match(/paddingVertical:\s*Spacing\.(three|four|five|six)/);
  if (minHeightMatch) {
    expect(Number(minHeightMatch[1])).toBeGreaterThanOrEqual(44);
    expect(body).not.toMatch(/minHeight:\s*0\b/);
  } else {
    // Backlog scope allows paddingVertical 12 as an alternative floor.
    expect(paddingVerticalMatch).not.toBeNull();
  }
});

test('the segment style is applied to the per-option pressables', () => {
  const src = nodeFs.readFileSync(
    [__dirname, '..', 'src', 'components', 'ui', 'SegmentedControl.tsx'].join(SEP),
    'utf8',
  );
  expect(src).toMatch(/style=\{styles\.segment\}/);
});