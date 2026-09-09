import { EMPTY_ROUTINES, applyRoutineRead, routinesListCopy } from '@/lib/gateway/routines';

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

describe('routines pane memo', () => {
  test('the pane imports memo and exports a memoized RoutinesPane', () => {
    // Every chat-screen tick that does not change `jobs`, `loaded`, `failed`,
    // `onCreate`, `onTogglePause`, `onRetry`, or `onChanged` would otherwise
    // re-render this subtree (its `useState` hooks, the draft form, and
    // the `<ListRow>` rows mapped from `jobs`). Memo stops it. The pane now
    // matches the pattern already shipped on `ChatHeader`
    // (chat-header.tsx:35,176), `ChatRoster` (chat-roster.tsx:320),
    // `SkillsPane` (skills-pane.tsx:14,81) and `ToolsPane`
    // (tools-pane.tsx:14,81).
    const src = readSource('src', 'components', 'chat', 'routines-pane.tsx');
    expect(src).toMatch(/import \{ memo, useState \} from 'react';/);
    expect(src).toMatch(/function RoutinesPaneImpl\(/);
    expect(src).toMatch(/export const RoutinesPane = memo\(RoutinesPaneImpl\);/);
    expect(src).toMatch(/RoutinesPane\.displayName = 'RoutinesPane';/);
  });

  test('the inner impl no longer exports a bare function', () => {
    // The previous top-level export `function RoutinesPane(...)` is gone —
    // otherwise React would happily take the un-memoized version.
    const src = readSource('src', 'components', 'chat', 'routines-pane.tsx');
    expect(src).not.toMatch(/export function RoutinesPane\(/);
    expect(src).not.toMatch(/export \{ RoutinesPaneImpl \}/);
  });

  test('the loading branch renders two Skeleton rows', () => {
    // byte-identical to the loading-branch contract from
    // `routines-pane-loading-test.ts`; memo only short-circuits, it does
    // not change what renders when the pane does re-render.
    const src = readSource('src', 'components', 'chat', 'routines-pane.tsx');
    const loading = src.match(/!loaded && !failed \? \([\s\S]*?\) : null/)?.[0];
    expect(loading).toBeDefined();
    expect(loading).toMatch(/<Skeleton width="90%" height=\{44\} \/>/);
    expect(loading).toMatch(/<Skeleton width="76%" height=\{44\} style=\{styles\.gap\} \/>/);
  });

  test('the failed-first Retry branch and its micro copy are byte-identical', () => {
    // Same shape as `routines-pane-loading-test.ts` and
    // `routines-pane-retry-test.ts` — memo must not touch the failure
    // surface.
    const src = readSource('src', 'components', 'chat', 'routines-pane.tsx');
    const failed = src.match(
      /!loaded && failed && onRetry \? \([\s\S]*?\) : null/,
    )?.[0];
    expect(failed).toBeDefined();
    expect(failed).toMatch(/label="Retry"/);
    expect(failed).toMatch(/onPress=\{onRetry\}/);
    expect(src.match(/label="Retry"/g)).toHaveLength(1);
    expect(routinesListCopy({ jobs: [], loaded: false, failed: true })).toBe(
      'Routines could not be read.',
    );
  });

  test('the draft form and its submit handlers are byte-identical', () => {
    // The create form (TextField/Button trio + the "New routine" micro copy)
    // is the largest of the three BotChrome children's bodies — a wasted
    // re-render here is the most expensive. Memo only short-circuits, it
    // does not change what the form renders.
    const src = readSource('src', 'components', 'chat', 'routines-pane.tsx');
    expect(src).toMatch(/<Text variant="micro" color="secondary">\n\s*New routine\n\s*<\/Text>/);
    expect(src).toContain('<TextField value={title} onChangeText={setTitle} placeholder="inbox" />');
    expect(src).toContain(
      '<TextField value={schedule} onChangeText={setSchedule} placeholder={DEFAULT_ROUTINE_SCHEDULE} />',
    );
    expect(src).toContain(
      '<TextField value={prompt} onChangeText={setPrompt} placeholder="Summarize overnight mail" multiline />',
    );
    expect(src).toMatch(/label=\{creating \? 'Adding…' : 'Add'\}/);
    expect(src).toMatch(/onPress=\{submitCreate\}/);
  });

  test('chat-screen wires the pane to useCallback-stable handlers', () => {
    // The action callbacks the pane takes (`onCreate`, `onTogglePause`)
    // were inline `async (input) => {...}` closures at
    // chat-screen.tsx:1272-1299 — fresh identities per render, so memo
    // alone would do nothing. The closures were extracted to
    // `handleRoutineCreate` / `handleRoutineTogglePause`
    // (mirroring `handleSkillInvoke` at chat-screen.tsx:611-620), keyed on
    // `botSurfaceId`/`botJobs`/`foldRoutineRead`/`routineJobsFromList`.
    // The sheet refresh reuses the already-stable `handleRoutinesRetry`,
    // so a row tap opening the sheet never disturbs the memo hold.
    const screen = readSource('src', 'components', 'chat', 'chat-screen.tsx');
    expect(screen).toMatch(/const handleRoutineCreate = useCallback\(/);
    expect(screen).toMatch(/const handleRoutineTogglePause = useCallback\(/);
    expect(screen).toContain('onCreate={handleRoutineCreate}');
    expect(screen).toContain('onTogglePause={handleRoutineTogglePause}');
    expect(screen).toContain('onChanged={handleRoutinesRetry}');
    // The inline closures that used to live at chat-screen.tsx:1272-1299 are
    // gone — otherwise memo would still see a fresh function every render.
    expect(screen).not.toMatch(/onCreate=\{async \(input\) => \{/);
    expect(screen).not.toMatch(/onTogglePause=\{async \(jobId, paused\) => \{/);
    // The call graph is unchanged for the two remaining handlers: they still
    // invoke `botJobs.create` / `botJobs.pause` / `botJobs.list`
    // in the same order, with the same `foldRoutineRead` fold and the same
    // `routineJobsFromList` parse — extracting the closures must not change
    // what runs, only the closure identity.
    expect(screen).toMatch(/await botJobs\.create\(\{/);
    expect(screen).toMatch(/await botJobs\.pause\(jobId, paused\)/);
    expect(screen).toMatch(/await botJobs\s*\n?\s*\.list\(\)/);
    expect(screen).toMatch(/foldRoutineRead\(target, \{ ok: true, jobs: routineJobsFromList\(jobs\) \}\)/);
  });

  test('the failed-first-read state still has no empty-jobs rendering', () => {
    // Sanity pin from `routines-pane-loading-test.ts`: a failed first read
    // keeps `jobs: []` with `failed: true` and the pane renders no empty
    // state — only micro copy. Memo must not change that.
    const state = applyRoutineRead(EMPTY_ROUTINES, { ok: false });
    expect(state).toEqual({ jobs: [], loaded: false, failed: true });
    expect(routinesListCopy(state)).toBe('Routines could not be read.');
    const src = readSource('src', 'components', 'chat', 'routines-pane.tsx');
    expect(src).not.toMatch(/No routines/);
  });
});