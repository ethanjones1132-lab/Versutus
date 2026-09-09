declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSheet(): string {
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'components', 'activity', 'agentic-run-sheet.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

describe('agentic run sheet retry', () => {
  test('a refused replay offers a ghost Retry wired to the existing fetch(runId)', () => {
    // A refused loadEvents left the operator with the formatRunFailure caption
    // and sheet-remount as the only recourse. The sheet now renders a ghost
    // Retry bound to the same re-read the mount effect runs.
    const src = readSheet();
    expect(src).toMatch(/import \{[^}]*Button[^}]*\} from '@\/components\/ui'/);
    const blocks = src.match(/\{error \? \([\s\S]*?\) : null\}/g);
    expect(blocks).toBeDefined();
    const retry = (blocks ?? []).find((block) => block.includes('label="Retry"'));
    expect(retry).toBeDefined();
    expect(retry).toMatch(/variant="ghost"/);
    expect(retry).toMatch(/onPress=\{\(\) => void fetch\(runId\)\}/);
  });

  test('the replay Retry renders only on the failed-read path, never over events', () => {
    const src = readSheet();
    const retry = src.match(/\{error \? \([\s\S]*?label="Retry"[\s\S]*?\) : null\}/)?.[0];
    expect(retry).toBeDefined();
    expect(src).not.toMatch(/events\.length.*Retry/);
  });

  test('the formatRunFailure verdict copy stays byte-identical', () => {
    const src = readSheet();
    expect(src).toContain('{formatRunFailure(error) ?? error}');
    expect(src).toMatch(/color="statusDisconnected"/);
  });

  test('the abort-on-unmount cleanup stays byte-identical', () => {
    const src = readSheet();
    expect(src).toMatch(/controllerRef\.current\?\.abort\(\)/);
    expect(src).toMatch(
      /useEffect\([\s\S]*?return \(\) => \{[\s\S]*?controllerRef\.current\?\.abort/,
    );
  });

  test('the loading skeletons stay byte-identical', () => {
    const src = readSheet();
    expect(src).toMatch(/Skeleton width="90%" height=\{44\}/);
    expect(src).toMatch(/Skeleton width="76%" height=\{44\}/);
    expect(src).toMatch(/Loading…/);
  });

  test('the empty-replay copy stays byte-identical', () => {
    const src = readSheet();
    expect(src).toContain('The replay completed without events.');
  });
});
