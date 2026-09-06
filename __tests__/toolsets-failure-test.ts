declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSectionSource(): string {
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'components', 'gateway', 'toolsets-section.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

describe('toolsets failure', () => {
  test('the failed first read renders the shared ErrorCard wired to the load handler', () => {
    // A refused tools.list left the operator with bare micro copy and no way
    // forward except remounting the screen. The pane now renders the shared
    // ErrorCard bound to the same re-read the mount effect runs.
    const src = readSectionSource();
    expect(src).toMatch(/error && !shown\.loaded \? \(/);
    const failed = src.match(/error && !shown\.loaded \? \([\s\S]*?\) : null/)?.[0];
    expect(failed).toBeDefined();
    expect(failed).toMatch(/<ErrorCard/);
    expect(failed).toMatch(/cause=\{error\}/);
    expect(failed).toMatch(/onRetry=\{\(\) => void load\(\)\}/);
  });

  test('the ErrorCard names the affected surface and the next step', () => {
    // Sibling Gateway-tab readers all render cause + affected + next + retry;
    // the toolsets card follows the same shape so the failure is actionable.
    const src = readSectionSource();
    expect(src).toMatch(/affected="[^"]*[Tt]ool/);
    expect(src).toMatch(/next="[^"]*[Rr]etry/);
  });

  test('the raw micro error branch is gone', () => {
    // The refused read used to render as bare micro copy in the failure
    // color with no retry affordance. That branch must not survive alongside
    // the card.
    const src = readSectionSource();
    expect(src).not.toMatch(/color="statusDisconnected" selectable/);
  });

  test('a failed first read never renders as "No tools"', () => {
    // The lib keeps the two failures distinct: a failed first read claims
    // zero knowledge, and only a successful read may claim the gateway has
    // none. A junk envelope parses as a failed read, never an empty-ok list.
    const {
      applyToolsetsRead,
      EMPTY_TOOLSETS,
      toolsetsListCopy,
      toolsetsReadFromUnknown,
    } = jest.requireActual('@/lib/gateway/toolsets') as typeof import(
      '@/lib/gateway/toolsets'
    );
    const read = toolsetsReadFromUnknown({ unexpected: 'envelope' });
    expect(read).toEqual({ ok: false });
    const state = applyToolsetsRead(EMPTY_TOOLSETS, read);
    expect(toolsetsListCopy(state)).toBe('Tools could not be read.');
    expect(toolsetsListCopy(state)).not.toBe('No tools.');
  });

  test('a failed re-read keeps the last good list with its stale copy', () => {
    // The retry must not disturb the stale-list path: a refused re-read
    // keeps the catalog on screen and names the staleness, exactly as today.
    const {
      applyToolsetsRead,
      EMPTY_TOOLSETS,
      toolsetsListCopy,
      toolsetsReadFromUnknown,
    } = jest.requireActual('@/lib/gateway/toolsets') as typeof import(
      '@/lib/gateway/toolsets'
    );
    const loaded = applyToolsetsRead(EMPTY_TOOLSETS, toolsetsReadFromUnknown({
      toolsets: [{ name: 'fs', description: 'read, write' }],
    }));
    expect(loaded.loaded).toBe(true);
    const stale = applyToolsetsRead(loaded, { ok: false });
    expect(stale.toolsets).toHaveLength(1);
    expect(stale.loaded).toBe(true);
    expect(toolsetsListCopy(stale)).toBe('Could not re-read tools — showing the last list.');
  });
});
