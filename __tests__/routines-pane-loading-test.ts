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

describe('routines pane loading', () => {
  test('the loading branch holds layout with two Skeleton rows', () => {
    // An opened pane showed only the New-routine form while botJobs.list
    // was in flight (the loading copy is undefined), then popped to full
    // rows when the read landed. The pane now renders skeletons like the
    // sibling skills/tools panes, so the layout holds instead of jumping.
    const src = readSource('src', 'components', 'chat', 'routines-pane.tsx');
    expect(src).toContain('Skeleton');
    const loading = src.match(/!loaded && !failed \? \([\s\S]*?\) : null/)?.[0];
    expect(loading).toBeDefined();
    expect(loading).toMatch(/<Skeleton width="90%" height=\{44\}/);
    expect(loading).toMatch(/<Skeleton width="76%" height=\{44\}/);
  });

  test('the loading copy is undefined, so the form-only window was real', () => {
    // routinesListCopy returns undefined while !loaded && !failed — the
    // only things the pane rendered in that window were the micro copy
    // that did not exist and the always-on create form, hence the pop.
    expect(routinesListCopy({ jobs: [], loaded: false, failed: false })).toBeUndefined();
  });

  test('the failed-first-read copy and its no-retry path are byte-identical', () => {
    const src = readSource('src', 'components', 'chat', 'routines-pane.tsx');
    expect(src).not.toContain('label="Retry"');
    expect(routinesListCopy({ jobs: [], loaded: false, failed: true })).toBe(
      'Routines could not be read.',
    );
  });

  test('a failed first read never renders as an empty-jobs line', () => {
    // A failed first read keeps jobs [] with failed true, and the pane
    // renders no empty-jobs state — only micro copy — so it cannot claim
    // the Bot has no routines when it knows nothing.
    const state = applyRoutineRead(EMPTY_ROUTINES, { ok: false });
    expect(state).toEqual({ jobs: [], loaded: false, failed: true });
    expect(routinesListCopy(state)).toBe('Routines could not be read.');
    const src = readSource('src', 'components', 'chat', 'routines-pane.tsx');
    expect(src).not.toMatch(/No routines/);
  });
});
