/** One skill the gateway reports. Name is required; description may be empty. */
export type Skill = {
  name: string;
  description: string;
};

/** What one skills list read produced. */
export type SkillsRead = { ok: true; skills: Skill[] } | { ok: false };

/**
 * Visible skills list after folding a read. Two failures are not the same
 * fact:
 *   - A failed FIRST read claims zero knowledge — not "no skills".
 *   - A failed RE-read keeps the last good list and marks it stale.
 * Only a successful read may clear or replace the list.
 */
export type SkillsState = {
  skills: Skill[];
  /** True once a successful read has landed. */
  loaded: boolean;
  failed: boolean;
};

export const EMPTY_SKILLS: SkillsState = { skills: [], loaded: false, failed: false };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function parseSkill(raw: unknown): Skill | null {
  if (!isRecord(raw)) return null;
  const name = (stringField(raw, 'name') ?? stringField(raw, 'id') ?? '').trim();
  if (!name) return null;
  const description = (stringField(raw, 'description') ?? '').trim();
  return { name, description };
}

function skillItems(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw;
  if (isRecord(raw) && Array.isArray(raw.data)) return raw.data;
  return null;
}

/**
 * Parse a skills.list / GET /v1/skills payload. Hermes returns a raw array
 * of `{ name, description, category }`. The Gate's REST stub and
 * `getSkills()` also wrap the same list as `{ data }`. Anything else is a
 * failed read — never an empty-ok list — so a junk envelope cannot render
 * as "no skills".
 */
export function skillsReadFromUnknown(raw: unknown): SkillsRead {
  const items = skillItems(raw);
  if (!items) return { ok: false };
  const skills: Skill[] = [];
  for (const item of items) {
    const skill = parseSkill(item);
    if (skill) skills.push(skill);
  }
  return { ok: true, skills };
}

export function applySkillsRead(previous: SkillsState, read: SkillsRead): SkillsState {
  if (read.ok) return { skills: read.skills, loaded: true, failed: false };
  if (previous.loaded) return { skills: previous.skills, loaded: true, failed: true };
  return { skills: [], loaded: false, failed: true };
}

export function skillsToggleLabel(state: SkillsState, open: boolean): string {
  if (open) return 'Hide skills';
  if (!state.loaded) return 'Skills';
  return `Skills (${state.skills.length})`;
}

export function skillsListCopy(state: SkillsState): string | undefined {
  if (!state.loaded && state.failed) return 'Skills could not be read.';
  if (state.failed) return 'Could not re-read skills — showing the last list.';
  if (state.loaded && state.skills.length === 0) return 'No skills.';
  return undefined;
}

/** Max height for the expanded skills list so a long catalog scrolls in place. */
export const SKILLS_PANE_MAX_HEIGHT = 280;
