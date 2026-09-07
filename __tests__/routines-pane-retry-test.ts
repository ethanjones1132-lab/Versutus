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

describe('routines pane retry', () => {
  test('the failed first read offers a Retry action wired to the retry callback', () => {
    // A failed first read left the operator with the micro copy and no way
    // forward except switching Bot or reconnecting. The pane now renders a
    // retry button bound to the re-read callback the surface owns.
    const src = readSource('src', 'components', 'chat', 'routines-pane.tsx');
    expect(src).toContain('onRetry');
    const failed = src.match(
      /!loaded && failed && onRetry \?\s*\([\s\S]*?\) : null/,
    )?.[0];
    expect(failed).toBeDefined();
    expect(failed).toMatch(/label="Retry"/);
    expect(failed).toMatch(/onPress=\{onRetry\}/);
  });

  test('the retry is offered only on the failed-first-read path, never over a list', () => {
    // A failed re-read keeps the last good list with its own stale copy —
    // the retry must not render there, and without a retry callback the
    // pane renders no button at all.
    const src = readSource('src', 'components', 'chat', 'routines-pane.tsx');
    // Exactly one Retry affordance exists, and it lives on the failed-first
    // branch — no retry renders over a loaded list or its stale copy.
    expect(src.match(/label="Retry"/g)).toHaveLength(1);
    expect(src).toContain('onRetry?: () => void;');
  });

  test('the failed-first-read micro copy still names the failure', () => {
    const src = readSource('src', 'components', 'chat', 'routines-pane.tsx');
    expect(src).toContain('routinesListCopy(state)');
    expect(routinesListCopy({ jobs: [], loaded: false, failed: true })).toBe(
      'Routines could not be read.',
    );
  });

  test('a failed re-read keeps the last good list with its stale copy', () => {
    // The lib keeps the two failures distinct: retrying over a loaded list
    // must never clear it, so the Retry path cannot strand the operator
    // with less than they had.
    const { applyRoutineRead: apply } = jest.requireActual(
      '@/lib/gateway/routines',
    ) as typeof import('@/lib/gateway/routines');
    const loaded = {
      jobs: [{ id: 'inbox', name: 'inbox' }],
      loaded: true,
      failed: false,
    };
    const next = apply(loaded, { ok: false });
    expect(next).toEqual({ jobs: loaded.jobs, loaded: true, failed: true });
    expect(routinesListCopy(next)).toBe(
      'Could not re-read routines — showing the last list.',
    );
  });

  test('a failed first read never renders as "No routines."', () => {
    // A failed first read keeps jobs [] with failed true, and the pane
    // renders no empty-jobs state — only micro copy — so it cannot claim
    // the Bot has no routines when it knows nothing.
    const state = applyRoutineRead(EMPTY_ROUTINES, { ok: false });
    expect(state).toEqual({ jobs: [], loaded: false, failed: true });
    expect(routinesListCopy(state)).toBe('Routines could not be read.');
    const src = readSource('src', 'components', 'chat', 'routines-pane.tsx');
    expect(src).not.toMatch(/No routines/);
  });

  test('chat-screen wires the retry to the same botJobs.list re-read', () => {
    const screen = readSource('src', 'components', 'chat', 'chat-screen.tsx');
    expect(screen).toContain('handleRoutinesRetry');
    expect(screen).toContain('onRetry={handleRoutinesRetry}');
    // The retry re-runs the surface effect's read: same botJobs.list call,
    // same routineJobsFromList parse, same fold into the per-Bot routine state.
    expect(screen).toMatch(/botJobs\s*\n?\s*\.list\(\)/);
    expect(screen).toMatch(/routineJobsFromList\(jobs\)/);
    expect(screen).toMatch(/applyRoutineRead\(previous,\s*\{\s*ok:\s*true/);
  });
});