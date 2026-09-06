import { applySkillsRead, EMPTY_SKILLS, skillsListCopy, skillsReadFromUnknown } from '@/lib/gateway/skills';

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

describe('skills pane retry', () => {
  test('the failed first read offers a Retry action wired to the retry callback', () => {
    // A failed first read left the operator with the micro copy and no way
    // forward except switching Bot or reconnecting. The pane now renders a
    // retry button bound to the re-read callback the surface owns.
    const src = readSource('src', 'components', 'chat', 'skills-pane.tsx');
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
    const src = readSource('src', 'components', 'chat', 'skills-pane.tsx');
    // Exactly one Retry affordance exists, and it lives on the failed-first
    // branch — no retry renders over a loaded list or its stale copy.
    expect(src.match(/label="Retry"/g)).toHaveLength(1);
    expect(src).toContain('onRetry?: () => void;');
  });

  test('the failed-first-read micro copy still names the failure', () => {
    const src = readSource('src', 'components', 'chat', 'skills-pane.tsx');
    expect(src).toContain('skillsListCopy(state)');
    expect(skillsListCopy({ skills: [], loaded: false, failed: true })).toBe(
      'Skills could not be read.',
    );
  });

  test('a failed re-read keeps the last good list with its stale copy', () => {
    // The lib keeps the two failures distinct: retrying over a loaded list
    // must never clear it, so the Retry path cannot strand the operator
    // with less than they had.
    const { applySkillsRead: apply } = jest.requireActual('@/lib/gateway/skills') as typeof import(
      '@/lib/gateway/skills'
    );
    const loaded = { skills: [{ name: 'weather', description: '' }], loaded: true, failed: false };
    const next = apply(loaded, { ok: false });
    expect(next).toEqual({ skills: loaded.skills, loaded: true, failed: true });
    expect(skillsListCopy(next)).toBe('Could not re-read skills — showing the last list.');
  });

  test('a failed first read never renders as "No skills."', () => {
    // A junk envelope parses as a failed read, never an empty-ok list, so
    // the pane cannot claim the gateway has none when it knows nothing.
    const read = skillsReadFromUnknown({ unexpected: 'envelope' });
    expect(read).toEqual({ ok: false });
    const state = applySkillsRead(EMPTY_SKILLS, read);
    expect(skillsListCopy(state)).toBe('Skills could not be read.');
  });

  test('chat-screen wires the retry to the same skills.list re-read', () => {
    const screen = readSource('src', 'components', 'chat', 'chat-screen.tsx');
    expect(screen).toContain('handleSkillsRetry');
    expect(screen).toContain('onRetry={handleSkillsRetry}');
    // The retry re-runs the surface effect's read: same method, same parse,
    // same fold into the per-Bot skills state.
    expect(screen).toMatch(/gatewayRequest\('skills\.list'\)/);
    expect(screen).toMatch(/fold\(skillsReadFromUnknown\(payload\)\)/);
  });
});
