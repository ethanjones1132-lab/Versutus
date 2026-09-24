import { applyToolsetsRead, EMPTY_TOOLSETS, toolsetsListCopy } from '@/lib/gateway/toolsets';

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(...parts: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

describe('tools failure keeps its cause', () => {
  test('the fold stores the caught message on a failed first read', () => {
    // Both chat-screen catch sites used to discard the caught message before
    // folding, so the pane could only ever show the fixed gray line. The
    // failure arm of ToolsetsRead now carries the cause into ToolsetsState.
    const state = applyToolsetsRead(EMPTY_TOOLSETS, {
      ok: false,
      error: 'Gate unreachable',
    });
    expect(state.failed).toBe(true);
    expect(state.loaded).toBe(false);
    expect(state.error).toBe('Gate unreachable');
    expect(toolsetsListCopy(state)).toBe('Tools could not be read.');
  });

  test('the fold stores the cause on a failed re-read and a success clears it', () => {
    const loaded = applyToolsetsRead(EMPTY_TOOLSETS, {
      ok: true,
      toolsets: [{ name: 'shell', description: '' }],
    });
    const stale = applyToolsetsRead(loaded, { ok: false, error: 'timeout' });
    expect(stale.error).toBe('timeout');
    expect(stale.toolsets).toEqual(loaded.toolsets);
    expect(stale.loaded).toBe(true);
    const fresh = applyToolsetsRead(stale, { ok: true, toolsets: [] });
    expect(fresh.error).toBeUndefined();
  });

  test('a failure with no message keeps the state honest and messageless', () => {
    // A junk envelope parses as { ok: false } with no cause — the fold must
    // not invent one, and the copy must stay the fixed line.
    const state = applyToolsetsRead(EMPTY_TOOLSETS, { ok: false });
    expect(state.error).toBeUndefined();
    expect(toolsetsListCopy(state)).toBe('Tools could not be read.');
  });

  test('chat-screen routes caught.message into both tools folds', () => {
    const screen = readSource('src', 'components', 'chat', 'chat-screen.tsx');
    const retry = screen.match(/const handleToolsetsRetry[\s\S]*?\}, \[toolsSurfaceKey/)?.[0];
    expect(retry).toBeDefined();
    expect(retry).toMatch(/catch\(\(caught\) =>\s*fold\(\{\s*ok: false,\s*error:/);
    expect(retry).not.toMatch(/fold\(\{ ok: false \}\)/);
    // The mount effect's refusal arm folds through the same kept message.
    expect(screen).toMatch(/applyToolsetsRead\(previous, \{\s*ok: false,\s*error:/);
    expect(screen).not.toMatch(/applyToolsetsRead\(previous, \{ ok: false \}\)/);
  });

  test('chat-screen threads the kept error into both ToolsPane call sites', () => {
    const screen = readSource('src', 'components', 'chat', 'chat-screen.tsx');
    expect(
      screen.match(
        /error=\{toolsetsState\.surfaceKey === toolsSurfaceKey \? toolsetsState\.error : undefined\}/g,
      ),
    ).toHaveLength(2);
  });

  test('the pane renders the kept cause as an ErrorCard with one Retry on a failed first read', () => {
    // The old surface was `toolsetsListCopy`'s fixed micro line beside a ghost
    // Retry — the operator saw that something failed, never why. The repo's
    // kept-cause contract (toolsets-section) is an ErrorCard whose cause is
    // the caught message, falling back to the lib copy when the failure
    // carried none (junk envelope).
    const src = readSource('src', 'components', 'chat', 'tools-pane.tsx');
    expect(src).toContain('ErrorCard');
    expect(src).toMatch(/error\?: string;/);
    const failed = src.match(/!loaded && failed \? \([\s\S]*?\) : null/)?.[0];
    expect(failed).toBeDefined();
    expect(failed).toMatch(/<ErrorCard/);
    expect(failed).toMatch(/cause=\{error \?\?/);
    expect(failed).toMatch(/onRetry=\{onRetry\}/);
    // One retry affordance: the ErrorCard's own — the ghost Retry is gone.
    expect(src.match(/label="Retry"/g) ?? []).toHaveLength(0);
  });

  test('the fixed copy line never renders over a failed first read the ErrorCard owns', () => {
    // The copy line stays for the loaded cases (stale re-read, empty list);
    // the failed-first branch is the ErrorCard alone, so the operator reads
    // one surface, not a caption plus a card.
    const src = readSource('src', 'components', 'chat', 'tools-pane.tsx');
    expect(src).toMatch(/loaded && copy \?/);
    expect(src).not.toMatch(/\{copy \? \(/);
  });

  test('keep-working: skeleton window, stale copy, empty copy, retry wiring', () => {
    const src = readSource('src', 'components', 'chat', 'tools-pane.tsx');
    const loading = src.match(/!loaded && !failed \? \([\s\S]*?\) : null/)?.[0];
    expect(loading).toBeDefined();
    expect(loading).toMatch(/<Skeleton width="90%" height=\{44\} \/>/);
    expect(loading).toMatch(/<Skeleton width="76%" height=\{44\} style=\{styles\.gap\} \/>/);
    expect(toolsetsListCopy({ toolsets: [], loaded: true, failed: false })).toBe('No tools.');
    expect(
      toolsetsListCopy({
        toolsets: [{ name: 'shell', description: '' }],
        loaded: true,
        failed: true,
      }),
    ).toBe('Could not re-read tools — showing the last list.');
    const screen = readSource('src', 'components', 'chat', 'chat-screen.tsx');
    expect(screen).toContain('onRetry={handleToolsetsRetry}');
    expect(screen).toMatch(/fold\(toolsetsReadFromUnknown\(payload\)\)/);
  });
});
