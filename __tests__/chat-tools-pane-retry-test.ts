import { applyToolsetsRead, EMPTY_TOOLSETS, toolsetsListCopy, toolsetsReadFromUnknown } from '@/lib/gateway/toolsets';

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

describe('chat tools pane retry', () => {
  test('the failed first read offers a Retry action wired to the retry callback', () => {
    // A failed first read left the operator with the micro copy and no way
    // forward except switching surface or reconnecting. The pane now renders
    // a retry button bound to the re-read callback the surface owns.
    const src = readSource('src', 'components', 'chat', 'tools-pane.tsx');
    expect(src).toContain('onRetry');
    const failed = src.match(
      /!loaded && failed && onRetry \? \([\s\S]*?\) : null/,
    )?.[0];
    expect(failed).toBeDefined();
    expect(failed).toMatch(/label="Retry"/);
    expect(failed).toMatch(/onPress=\{onRetry\}/);
  });

  test('the retry is offered only on the failed-first-read path, never over a list', () => {
    // A failed re-read keeps the last good list with its own stale copy —
    // the retry must not render there, and without a retry callback the
    // pane renders no button at all.
    const src = readSource('src', 'components', 'chat', 'tools-pane.tsx');
    // Exactly one Retry affordance exists, and it lives on the failed-first
    // branch — no retry renders over a loaded list or its stale copy.
    expect(src.match(/label="Retry"/g)).toHaveLength(1);
    expect(src).toContain('onRetry?: () => void;');
  });

  test('the failed-first-read micro copy still names the failure', () => {
    const src = readSource('src', 'components', 'chat', 'tools-pane.tsx');
    expect(src).toContain('toolsetsListCopy(state)');
    expect(toolsetsListCopy({ toolsets: [], loaded: false, failed: true })).toBe(
      'Tools could not be read.',
    );
  });

  test('a failed re-read keeps the last good list with its stale copy', () => {
    // The lib keeps the two failures distinct: retrying over a loaded list
    // must never clear it, so the Retry path cannot strand the operator
    // with less than they had.
    const { applyToolsetsRead: apply } = jest.requireActual('@/lib/gateway/toolsets') as typeof import(
      '@/lib/gateway/toolsets'
    );
    const loaded = { toolsets: [{ name: 'shell', description: '' }], loaded: true, failed: false };
    const next = apply(loaded, { ok: false });
    expect(next).toEqual({ toolsets: loaded.toolsets, loaded: true, failed: true });
    expect(toolsetsListCopy(next)).toBe('Could not re-read tools — showing the last list.');
  });

  test('a failed first read never renders as "No tools."', () => {
    // A junk envelope parses as a failed read, never an empty-ok list, so
    // the pane cannot claim the gateway has none when it knows nothing.
    const read = toolsetsReadFromUnknown({ unexpected: 'envelope' });
    expect(read).toEqual({ ok: false });
    const state = applyToolsetsRead(EMPTY_TOOLSETS, read);
    expect(toolsetsListCopy(state)).toBe('Tools could not be read.');
  });

  test('chat-screen wires the retry to the same tools.list re-read on both surfaces', () => {
    const screen = readSource('src', 'components', 'chat', 'chat-screen.tsx');
    expect(screen).toContain('handleToolsetsRetry');
    // Both ToolsPane usages (inside BotChrome and standalone) get the retry.
    expect(screen.match(/onRetry=\{handleToolsetsRetry\}/g)).toHaveLength(2);
    // The retry re-runs the surface effect's read: same method, same params,
    // same parse, same fold into the per-surface toolsets state.
    expect(screen).toMatch(/gatewayRequest\('tools\.list', toolsetsListParams\(/);
    expect(screen).toMatch(/fold\(toolsetsReadFromUnknown\(payload\)\)/);
  });
});
