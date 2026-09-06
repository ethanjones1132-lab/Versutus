import { EMPTY_SKILLS, applySkillsRead, skillsListCopy, skillsReadFromUnknown } from '@/lib/gateway/skills';

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

describe('skills pane loading', () => {
  test('the loading branch holds layout with two Skeleton rows', () => {
    // An opened pane showed a blank scroll while skills.list was in flight
    // (the loading copy is undefined), then popped to full rows when the
    // read landed. The pane now renders skeletons like the Gateway-tab
    // panes, so the layout holds instead of jumping.
    const src = readSource('src', 'components', 'chat', 'skills-pane.tsx');
    expect(src).toContain('Skeleton');
    const loading = src.match(/!loaded && !failed \? \([\s\S]*?\) : null/)?.[0];
    expect(loading).toBeDefined();
    expect(loading).toMatch(/<Skeleton width="90%" height=\{44\}/);
    expect(loading).toMatch(/<Skeleton width="76%" height=\{44\}/);
  });

  test('the loading copy is undefined, so the blank was real', () => {
    // skillsListCopy returns undefined while !loaded && !failed — the only
    // thing the pane rendered in that window was micro copy that did not
    // exist, hence the blank scroll.
    expect(skillsListCopy({ skills: [], loaded: false, failed: false })).toBeUndefined();
  });

  test('the failed-first-read Retry and its micro copy are byte-identical', () => {
    const src = readSource('src', 'components', 'chat', 'skills-pane.tsx');
    expect(src.match(/label="Retry"/g)).toHaveLength(1);
    expect(src).toContain('!loaded && failed && onRetry');
    expect(skillsListCopy({ skills: [], loaded: false, failed: true })).toBe(
      'Skills could not be read.',
    );
  });

  test('a failed first read never renders as "No skills."', () => {
    // A junk envelope parses as a failed read, never an empty-ok list, so
    // the pane cannot claim the gateway has none when it knows nothing.
    const read = skillsReadFromUnknown({ unexpected: 'envelope' });
    expect(read).toEqual({ ok: false });
    const state = applySkillsRead(EMPTY_SKILLS, read);
    expect(skillsListCopy(state)).toBe('Skills could not be read.');
  });
});
