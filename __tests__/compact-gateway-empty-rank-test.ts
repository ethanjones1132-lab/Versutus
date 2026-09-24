declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readListSource(): string {
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'components', 'gateway', 'compact-gateway-list.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

describe('compact gateway list empty state and row rank', () => {
  test('the zero-gateway branch renders the EmptyState idiom, not stacked captions', () => {
    // Every peer empty surface (roster, runs, spend, providers) draws the
    // repo's EmptyState — glyph, headline, description. The saved-gateway
    // list was the holdout: two bare captions stacked inside a Card.
    const src = readListSource();
    const emptyBranch = src.match(/if \(gateways\.length === 0\) \{[\s\S]*?\n  \}/)?.[0];
    expect(emptyBranch).toBeDefined();
    expect(emptyBranch!).toContain('<EmptyState');
    expect(emptyBranch!).toMatch(/title="No gateways saved"/);
    expect(emptyBranch!).not.toMatch(/variant="caption"/);
    expect(src).not.toMatch(
      /<Text variant="caption"[^>]*>No gateways saved<\/Text>/,
    );
  });

  test('the empty description copy is byte-kept on the EmptyState', () => {
    const src = readListSource();
    expect(src).toMatch(
      /description="Add your first gateway \(Hermes, Gate, or OpenClaw\) to unlock chat, tools, and commands\."/,
    );
  });

  test('the gateway name reads at headline rank, not caption', () => {
    // Roster rows and management-section rows put the entity name at
    // headline/ListRow rank; the saved-gateway name was the dimmest text
    // on the row while the URL below it was mono-secondary.
    const src = readListSource();
    const nameBlock = src.match(
      /<Text variant="headline" numberOfLines=\{1\} style=\{styles\.onGlassPrimary\}>\s*\{gateway\.name\}\s*<\/Text>/,
    );
    expect(nameBlock).toBeDefined();
    expect(src).not.toMatch(
      /<Text variant="caption" numberOfLines=\{1\} style=\{styles\.onGlassPrimary\}>\s*\{gateway\.name\}/,
    );
  });

  test('the URL expand toggle still owns the mono URL line', () => {
    const src = readListSource();
    expect(src).toMatch(/const \[urlExpanded, setUrlExpanded\] = useState\(false\);/);
    const target = src.match(
      /<PressableScale[\s\S]*?\{gateway\.url\}[\s\S]*?<\/PressableScale>/,
    )?.[0];
    expect(target).toBeDefined();
    expect(target).toMatch(/numberOfLines=\{\s*urlExpanded \? undefined : 1\s*\}/);
  });

  test('the Remove hint stays the file\'s only accessibilityHint', () => {
    const src = readListSource();
    const hits = src.match(/accessibilityHint/g) ?? [];
    expect(hits).toHaveLength(1);
    expect(src).toMatch(
      /label="Remove"[\s\S]*?accessibilityHint="Opens a confirmation, then removes this saved gateway from the app\./,
    );
  });

  test('the Active badge and reachability pill keep their caption lines', () => {
    // Only the entity name moves up a rank; the Active chip and pill label
    // stay secondary metadata beside it.
    const src = readListSource();
    expect(src).toMatch(
      /<Text variant="caption" color="accent">\s*Active\s*<\/Text>/,
    );
    expect(src).toMatch(
      /<Text variant="caption" numberOfLines=\{1\} style=\{styles\.onGlassSecondary\}>\s*\{label\}\s*<\/Text>/,
    );
  });
});
