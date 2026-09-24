import { applyRoutineRead, EMPTY_ROUTINES, routinesListCopy } from '@/lib/gateway/routines';

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

describe('routines failure keeps its cause', () => {
  test('the fold stores the caught message on a failed first read', () => {
    // All four chat-screen catch sites used to discard the caught message
    // before folding, so the pane could only ever show the fixed gray line.
    // The failure arm of RoutineRead now carries the cause into
    // RoutinesState.
    const state = applyRoutineRead(EMPTY_ROUTINES, {
      ok: false,
      error: 'Gate unreachable',
    });
    expect(state.failed).toBe(true);
    expect(state.loaded).toBe(false);
    expect(state.error).toBe('Gate unreachable');
    expect(routinesListCopy(state)).toBe('Routines could not be read.');
  });

  test('the fold stores the cause on a failed re-read and a success clears it', () => {
    const loaded = applyRoutineRead(EMPTY_ROUTINES, {
      ok: true,
      jobs: [{ id: 'inbox', name: '[bot:echo] inbox', paused: false }],
    });
    const stale = applyRoutineRead(loaded, { ok: false, error: 'timeout' });
    expect(stale.error).toBe('timeout');
    expect(stale.jobs).toEqual(loaded.jobs);
    expect(stale.loaded).toBe(true);
    const fresh = applyRoutineRead(stale, { ok: true, jobs: [] });
    expect(fresh.error).toBeUndefined();
  });

  test('a failure with no message keeps the state honest and messageless', () => {
    // A junk envelope parses as { ok: false } with no cause — the fold must
    // not invent one, and the copy must stay the fixed line.
    const state = applyRoutineRead(EMPTY_ROUTINES, { ok: false });
    expect(state.error).toBeUndefined();
    expect(routinesListCopy(state)).toBe('Routines could not be read.');
  });

  test('chat-screen routes caught.message into all four routines folds', () => {
    const screen = readSource('src', 'components', 'chat', 'chat-screen.tsx');
    const retry = screen.match(/const handleRoutinesRetry[\s\S]*?\}, \[botSurfaceId/)?.[0];
    expect(retry).toBeDefined();
    expect(retry).toMatch(/catch\(\(caught\) =>/);
    expect(retry).toMatch(/applyRoutineRead\(previous,\s*\{\s*ok:\s*false,\s*error:/);
    expect(retry).not.toMatch(/\{ ok: false \}\)/);
    // Create re-list, pause re-list, and the mount effect fold the same
    // kept message through foldRoutineRead.
    expect(screen).toMatch(
      /\.catch\(\(caught\) =>\s*foldRoutineRead\([^,]+,\s*\{\s*ok:\s*false,\s*error:/,
    );
    expect(screen).not.toMatch(/foldRoutineRead\([^,]+, \{ ok: false \}\)/);
    expect(screen).not.toMatch(/applyRoutineRead\(previous, \{ ok: false \}\)/);
    // The mount effect's refusal arm folds through the same kept message.
    expect(screen).toMatch(
      /\.catch\(\(caught\) =>\s*\{\s*if \(cancelled\) return;\s*foldRoutineRead\(botSurfaceId, \{\s*ok:\s*false,\s*error:/,
    );
  });

  test('chat-screen threads the kept error into the pane beside loaded/failed', () => {
    const screen = readSource('src', 'components', 'chat', 'chat-screen.tsx');
    expect(screen).toMatch(
      /readError=\{routineState\.botId === surface\.botId \? routineState\.error : undefined\}/,
    );
  });

  test('the pane renders the kept cause as an ErrorCard with one Retry on a failed first read', () => {
    // The old surface was `routinesListCopy`'s fixed micro line beside a
    // ghost Retry — the operator saw that something failed, never why. The
    // repo's kept-cause contract (skills/tools panes) is an ErrorCard whose
    // cause is the caught message, falling back to the lib copy when the
    // failure carried none (junk envelope). The prop is `readError` because
    // the pane's local create/pause `error` channel already owns `error`.
    const src = readSource('src', 'components', 'chat', 'routines-pane.tsx');
    expect(src).toContain('ErrorCard');
    expect(src).toMatch(/readError\?: string;/);
    const failed = src.match(/!loaded && failed \? \([\s\S]*?\) : null/)?.[0];
    expect(failed).toBeDefined();
    expect(failed).toMatch(/<ErrorCard/);
    expect(failed).toMatch(/cause=\{readError \?\?/);
    expect(failed).toMatch(/onRetry=\{onRetry\}/);
    // One retry affordance: the ErrorCard's own — the ghost Retry is gone.
    expect(src.match(/label="Retry"/g) ?? []).toHaveLength(0);
  });

  test('the fixed copy line never renders over a failed first read the ErrorCard owns', () => {
    // The copy line stays for the loaded cases (stale re-read); the
    // failed-first branch is the ErrorCard alone, so the operator reads one
    // surface, not a caption plus a card.
    const src = readSource('src', 'components', 'chat', 'routines-pane.tsx');
    expect(src).toMatch(/loaded && listCopy \?/);
    expect(src).not.toMatch(/\{listCopy \? \(/);
  });

  test('keep-working: skeleton window, stale copy, create/pause error channel, retry wiring', () => {
    const src = readSource('src', 'components', 'chat', 'routines-pane.tsx');
    const loading = src.match(/!loaded && !failed \? \([\s\S]*?\) : null/)?.[0];
    expect(loading).toBeDefined();
    expect(loading).toMatch(/<Skeleton width="90%" height=\{44\} \/>/);
    expect(loading).toMatch(/<Skeleton width="76%" height=\{44\} style=\{styles\.gap\} \/>/);
    expect(
      routinesListCopy({
        jobs: [{ id: 'inbox', name: '[bot:echo] inbox', paused: false }],
        loaded: true,
        failed: true,
      }),
    ).toBe('Could not re-read routines — showing the last list.');
    // The pane's local create/pause failure channel is untouched: its own
    // `error` state still renders as the brand accent caption.
    expect(src).toMatch(/const \[error, setError\] = useState<string \| undefined>\(\);/);
    expect(src).toMatch(/\{error \? \(\s*<Text variant="caption" color="accent">/);
    const screen = readSource('src', 'components', 'chat', 'chat-screen.tsx');
    expect(screen).toContain('onRetry={handleRoutinesRetry}');
    expect(screen).toContain('onChanged={handleRoutinesRetry}');
  });
});
