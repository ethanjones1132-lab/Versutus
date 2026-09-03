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

/**
 * The exact turn text a skills-pane tap dispatches — the same `/<skill-name>`
 * the typed path sends through `sendChatInput`, so `matchSkillSlash` and
 * `shouldPassthroughSkillSlash` judge it identically. The pane shows the bare
 * name, so there is no instruction to carry; the operator adds one in the
 * thread when they want it.
 */
export function skillSlashText(name: string): string {
  return `/${name.trim()}`;
}

/**
 * Whether a pane tap can only prefill the composer. A tap dispatches through
 * `sendChatInput`, whose skill path reaches `sendMessage` — and `sendMessage`
 * returns silently while a turn streams (`isSending`), while a slash command
 * runs (`isCommandRunning`), or while there is no live gateway to answer.
 * Prefilling `/${name} ` keeps the tap honest instead of dropping it.
 */
export function skillInvokePrefillsComposer(state: {
  status: string;
  isSending: boolean;
  isCommandRunning: boolean;
}): boolean {
  return state.status !== 'connected' || state.isSending || state.isCommandRunning;
}

/**
 * Hermes treats a skill as `/name` plus the rest of the line as instruction.
 * Returns null when the input is not a slash, or the first token is not a
 * fetched skill name.
 */
export function matchSkillSlash(
  input: string,
  skills: Skill[],
): { skill: Skill; instruction: string } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;
  const rest = trimmed.slice(1);
  const space = rest.search(/\s/);
  const name = (space < 0 ? rest : rest.slice(0, space)).toLowerCase();
  if (!name) return null;
  const skill = skills.find((item) => item.name.toLowerCase() === name);
  if (!skill) return null;
  return { skill, instruction: space < 0 ? '' : rest.slice(space).trim() };
}
