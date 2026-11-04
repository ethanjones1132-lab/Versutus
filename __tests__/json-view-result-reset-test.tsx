declare const __dirname: string;
const fs = jest.requireActual('fs') as { readFileSync(path: string, encoding: string): string };
const SEP = __dirname.includes('\\') ? '\\' : '/';

describe('JsonView expansion resets for a new result', () => {
  const src = fs.readFileSync([__dirname, '..', 'src', 'components', 'terminal', 'json-view.tsx'].join(SEP), 'utf8');

  it('resets expansion only when the memoized defaults change', () => {
    expect(src).toMatch(/const \[expanded, setExpanded\] = useState<Set<string>>\(\(\) => initial\);/);
    expect(src).toMatch(/useEffect\(\(\) => \{\s*setExpanded\(initial\);\s*\}, \[initial\]\);/);
    expect(src).toContain('collectJsonTreeContainerPaths(root, maxDepth)');
  });

  it('keeps the default depth and existing toggle/copy paths', () => {
    expect(src).toContain('maxDepth = 2');
    expect(src).toContain('if (next.has(path)) next.delete(path);');
    expect(src).toContain('Clipboard.setStringAsync(text)');
  });
});
