// One surface family, one shadow API. React Native deprecated the `shadow*`
// style props (and `textShadow*`) in favour of `boxShadow` / `textShadow`, and
// every web boot prints the warning while any caller still uses them. This
// guard keeps the deprecated names from creeping back in: a new caller should
// reach for the token-driven `boxShadow` string the platform now documents.

declare const __dirname: string;

const fs = jest.requireActual('fs') as {
  readdirSync(path: string): string[];
  readFileSync(path: string, encoding: string): string;
  statSync(path: string): { isDirectory(): boolean };
};
const path = jest.requireActual('path') as {
  join(...parts: string[]): string;
};

const ROOT = path.join(__dirname, '..', 'src');

/** `shadowColor:`, `textShadowOffset:` — a style property, not prose. */
const DEPRECATED = /\b(shadowColor|shadowOpacity|shadowRadius|shadowOffset|textShadowColor|textShadowOffset|textShadowRadius)\s*:/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory()) {
      out.push(...walk(full));
      continue;
    }
    if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

test('no source file uses a deprecated shadow style prop', () => {
  const offenders: string[] = [];
  for (const file of walk(ROOT)) {
    const source = fs.readFileSync(file, 'utf8');
    source.split('\n').forEach((line, index) => {
      const match = line.match(DEPRECATED);
      if (match) offenders.push(`${file.slice(ROOT.length + 1)}:${index + 1} uses ${match[1]}`);
    });
  }
  expect(offenders).toEqual([]);
});
