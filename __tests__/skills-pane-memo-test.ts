import { skillsListCopy } from '@/lib/gateway/skills';

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

describe('skills pane memo', () => {
  test('the pane imports memo and exports a memoized SkillsPane', () => {
    // Every chat-screen tick that does not change `skills`, `loaded`,
    // `failed`, `onInvoke`, or `onRetry` would otherwise re-render this
    // subtree; memo stops it. The pane now matches the pattern already
    // shipped on `ChatHeader` (chat-header.tsx:35,176) and `ChatRoster`
    // (chat-roster.tsx:320).
    const src = readSource('src', 'components', 'chat', 'skills-pane.tsx');
    expect(src).toMatch(/import \{ memo, useState \} from 'react';/);
    expect(src).toMatch(/function SkillsPaneImpl\(/);
    expect(src).toMatch(/export const SkillsPane = memo\(SkillsPaneImpl\);/);
    expect(src).toMatch(/SkillsPane\.displayName = 'SkillsPane';/);
  });

  test('the inner impl no longer exports a bare function', () => {
    // The previous top-level export `function SkillsPane(...)` is gone —
    // otherwise React would happily take the un-memoized version.
    const src = readSource('src', 'components', 'chat', 'skills-pane.tsx');
    expect(src).not.toMatch(/export function SkillsPane\(/);
    expect(src).not.toMatch(/export \{ SkillsPaneImpl \}/);
  });

  test('the loading branch renders two Skeleton rows', () => {
    // byte-identical to the loading-branch contract from
    // `skills-pane-loading-test.ts`; memo only short-circuits, it does
    // not change what renders when the pane does re-render.
    const src = readSource('src', 'components', 'chat', 'skills-pane.tsx');
    const loading = src.match(/!loaded && !failed \? \([\s\S]*?\) : null/)?.[0];
    expect(loading).toBeDefined();
    expect(loading).toMatch(/<Skeleton width="90%" height=\{44\} \/>/);
    expect(loading).toMatch(/<Skeleton width="76%" height=\{44\} style=\{styles\.gap\} \/>/);
  });

  test('the failed-first Retry branch and its micro copy are byte-identical', () => {
    // Same shape as `skills-pane-loading-test.ts` and
    // `skills-pane-retry-test.ts` — memo must not touch the failure
    // surface.
    const src = readSource('src', 'components', 'chat', 'skills-pane.tsx');
    const failed = src.match(
      /!loaded && failed && onRetry \? \([\s\S]*?\) : null/,
    )?.[0];
    expect(failed).toBeDefined();
    expect(failed).toMatch(/label="Retry"/);
    expect(failed).toMatch(/onPress=\{onRetry\}/);
    expect(src.match(/label="Retry"/g)).toHaveLength(1);
    expect(skillsListCopy({ skills: [], loaded: false, failed: true })).toBe(
      'Skills could not be read.',
    );
  });

  test('chat-screen still wires the same five props through the same call site', () => {
    // The single call site at chat-screen.tsx:1252-1258 must keep using
    // `SkillsPane` with the same five props the pane expects.
    const screen = readSource('src', 'components', 'chat', 'chat-screen.tsx');
    expect(screen).toContain('<SkillsPane');
    expect(screen).toMatch(/skills=\{skillsState\.botId === surface\.botId \? skillsState\.skills : \[\]\}/);
    expect(screen).toContain('onInvoke={handleSkillInvoke}');
    expect(screen).toContain('onRetry={handleSkillsRetry}');
    expect(screen).toContain('handleSkillInvoke');
    expect(screen).toContain('handleSkillsRetry');
  });
});