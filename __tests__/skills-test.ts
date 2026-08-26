import {
  applySkillsRead,
  EMPTY_SKILLS,
  skillsListCopy,
  skillsReadFromUnknown,
  skillsToggleLabel,
  type Skill,
} from '@/lib/gateway/skills';

const WEATHER: Skill = { name: 'weather', description: 'Look up the forecast' };
const GITHUB: Skill = { name: 'github-pr-workflow', description: 'Full PR lifecycle' };

test('a Hermes skills array becomes name plus description', () => {
  const read = skillsReadFromUnknown([
    { name: 'github-pr-workflow', description: 'Full PR lifecycle', category: 'git' },
    { name: 'weather', description: 'Look up the forecast' },
  ]);
  expect(read).toEqual({ ok: true, skills: [GITHUB, WEATHER] });
});

test('a { data } envelope unwraps the same way getSkills already does', () => {
  const read = skillsReadFromUnknown({
    data: [{ name: 'weather', description: 'Look up the forecast' }],
  });
  expect(read).toEqual({ ok: true, skills: [WEATHER] });
});

test('a skill named only by id still parses — Gate stubs use id, not name', () => {
  const read = skillsReadFromUnknown({ data: [{ id: 'skill-1' }] });
  expect(read).toEqual({ ok: true, skills: [{ name: 'skill-1', description: '' }] });
});

test('nameless and non-object items are dropped, not a failed read', () => {
  const read = skillsReadFromUnknown([
    null,
    42,
    { description: 'no name' },
    { name: '  ' },
    { name: 'weather', description: 'Look up the forecast' },
  ]);
  expect(read).toEqual({ ok: true, skills: [WEATHER] });
});

test('an empty array is empty-ok — the host really has no skills', () => {
  expect(skillsReadFromUnknown([])).toEqual({ ok: true, skills: [] });
  expect(skillsReadFromUnknown({ data: [] })).toEqual({ ok: true, skills: [] });
});

test('an unparseable payload is a failed read, not "no skills"', () => {
  expect(skillsReadFromUnknown(null).ok).toBe(false);
  expect(skillsReadFromUnknown('nope').ok).toBe(false);
  expect(skillsReadFromUnknown({ error: 'boom' }).ok).toBe(false);
});

test('a failed FIRST read claims zero knowledge — not an empty list', () => {
  const next = applySkillsRead(EMPTY_SKILLS, { ok: false });
  expect(next.skills).toEqual([]);
  expect(next.loaded).toBe(false);
  expect(next.failed).toBe(true);
  expect(skillsToggleLabel(next, false)).toBe('Skills');
  expect(skillsToggleLabel(next, false)).not.toContain('0');
  expect(skillsListCopy(next)).toBe('Skills could not be read.');
});

test('a failed RE-read keeps the last good list and names the staleness', () => {
  const loaded = applySkillsRead(EMPTY_SKILLS, { ok: true, skills: [WEATHER, GITHUB] });
  const stale = applySkillsRead(loaded, { ok: false });
  expect(stale.skills).toEqual([WEATHER, GITHUB]);
  expect(stale.loaded).toBe(true);
  expect(stale.failed).toBe(true);
  expect(skillsToggleLabel(stale, false)).toBe('Skills (2)');
  expect(skillsListCopy(stale)).toBe('Could not re-read skills — showing the last list.');
});

test('a successful EMPTY read is believed — the host really has none now', () => {
  const previous = applySkillsRead(EMPTY_SKILLS, { ok: true, skills: [WEATHER] });
  const next = applySkillsRead(previous, { ok: true, skills: [] });
  expect(next).toEqual({ skills: [], loaded: true, failed: false });
  expect(skillsToggleLabel(next, false)).toBe('Skills (0)');
  expect(skillsListCopy(next)).toBe('No skills.');
});

test('a successful refresh replaces the list', () => {
  const previous = applySkillsRead(EMPTY_SKILLS, { ok: true, skills: [WEATHER] });
  const next = applySkillsRead(previous, { ok: true, skills: [GITHUB] });
  expect(next.skills).toEqual([GITHUB]);
  expect(next.failed).toBe(false);
});

test('the open toggle hides the count the way Routines does', () => {
  const loaded = applySkillsRead(EMPTY_SKILLS, { ok: true, skills: [WEATHER] });
  expect(skillsToggleLabel(loaded, true)).toBe('Hide skills');
  expect(skillsToggleLabel(EMPTY_SKILLS, false)).toBe('Skills');
  expect(skillsListCopy(EMPTY_SKILLS)).toBeUndefined();
});
