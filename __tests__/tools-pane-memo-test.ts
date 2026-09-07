import { toolsetsListCopy } from '@/lib/gateway/toolsets';

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

describe('tools pane memo', () => {
  test('the pane imports memo and exports a memoized ToolsPane', () => {
    // Every chat-screen tick that does not change `toolsets`, `loaded`,
    // `failed`, or `onRetry` would otherwise re-render this subtree; memo
    // stops it. The pane now matches the pattern already shipped on
    // `ChatHeader` (chat-header.tsx:35,176), `ChatRoster`
    // (chat-roster.tsx:320), and `SkillsPane` (skills-pane.tsx:81).
    const src = readSource('src', 'components', 'chat', 'tools-pane.tsx');
    expect(src).toMatch(/import \{ memo, useState \} from 'react';/);
    expect(src).toMatch(/function ToolsPaneImpl\(/);
    expect(src).toMatch(/export const ToolsPane = memo\(ToolsPaneImpl\);/);
    expect(src).toMatch(/ToolsPane\.displayName = 'ToolsPane';/);
  });

  test('the inner impl no longer exports a bare function', () => {
    // The previous top-level export `function ToolsPane(...)` is gone —
    // otherwise React would happily take the un-memoized version.
    const src = readSource('src', 'components', 'chat', 'tools-pane.tsx');
    expect(src).not.toMatch(/export function ToolsPane\(/);
    expect(src).not.toMatch(/export \{ ToolsPaneImpl \}/);
  });

  test('the loading branch renders two Skeleton rows', () => {
    // byte-identical to the loading-branch contract from
    // `chat-tools-pane-loading-test.ts`; memo only short-circuits, it does
    // not change what renders when the pane does re-render.
    const src = readSource('src', 'components', 'chat', 'tools-pane.tsx');
    const loading = src.match(/!loaded && !failed \?\s*\([\s\S]*?\) : null/)?.[0];
    expect(loading).toBeDefined();
    expect(loading).toMatch(/<Skeleton width="90%" height=\{44\} \/>/);
    expect(loading).toMatch(/<Skeleton width="76%" height=\{44\} style=\{styles\.gap\} \/>/);
  });

  test('the failed-first Retry branch and its micro copy are byte-identical', () => {
    // Same shape as `chat-tools-pane-loading-test.ts` and
    // `chat-tools-pane-retry-test.ts` — memo must not touch the failure
    // surface.
    const src = readSource('src', 'components', 'chat', 'tools-pane.tsx');
    const failed = src.match(
      /!loaded && failed && onRetry \?\s*\([\s\S]*?\) : null/,
    )?.[0];
    expect(failed).toBeDefined();
    expect(failed).toMatch(/label="Retry"/);
    expect(failed).toMatch(/onPress=\{onRetry\}/);
    expect(src.match(/label="Retry"/g)).toHaveLength(1);
    expect(toolsetsListCopy({ toolsets: [], loaded: false, failed: true })).toBe(
      'Tools could not be read.',
    );
  });

  test('chat-screen still wires the same four props through both call sites', () => {
    // The two call sites at chat-screen.tsx:1260-1265 (inside BotChrome)
    // and chat-screen.tsx:1303-1308 (standalone fallback) must keep using
    // `ToolsPane` with the same four props the pane expects.
    const screen = readSource('src', 'components', 'chat', 'chat-screen.tsx');
    const matches = screen.match(/<ToolsPane\b/g) ?? [];
    expect(matches.length).toBe(2);
    expect(screen).toMatch(
      /toolsets=\{toolsetsState\.surfaceKey === toolsSurfaceKey \? toolsetsState\.toolsets : \[\]\}/,
    );
    expect(screen).toContain('onRetry={handleToolsetsRetry}');
    expect(screen).toContain('handleToolsetsRetry');
  });
});