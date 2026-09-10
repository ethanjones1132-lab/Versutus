import {
  ROUTINE_TEMPLATES,
  applyRoutineTemplate,
  routineTemplateByKey,
} from '@/lib/gateway/routine-templates';
import { type RoutineDraft } from '@/lib/gateway/routines';

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

const pane = () => readSource('src', 'components', 'chat', 'routines-pane.tsx');

/** D4's packs, in the order the pane lists them. */
const PACK_LABELS = [
  'Morning briefing',
  'Inbox triage',
  'Server watchdog',
  'Weekly code review',
];

const MINE: RoutineDraft = {
  title: 'mine',
  prompt: 'what I typed myself',
  schedule: '0 0 * * *',
};

describe('routine template catalogue', () => {
  test('every pack carries a key, a label and a one-line description', () => {
    // A row is a label over a line saying what the routine does; a pack
    // missing either is a row the operator cannot choose between.
    expect(ROUTINE_TEMPLATES.length).toBeGreaterThan(0);
    for (const pack of ROUTINE_TEMPLATES) {
      expect(pack.key.trim()).not.toBe('');
      expect(pack.label.trim()).not.toBe('');
      expect(pack.description.trim()).not.toBe('');
    }
  });

  test('every pack prefills a title and a prompt', () => {
    // Add is disabled until both are non-empty, so a pack that left either
    // blank would ship a row that cannot finish.
    for (const pack of ROUTINE_TEMPLATES) {
      expect(pack.draft.title.trim()).not.toBe('');
      expect(pack.draft.prompt.trim()).not.toBe('');
    }
  });

  test('every pack carries a five-field cron schedule', () => {
    // The gateway's create path takes a plain cron expression; the pane's
    // own fallback is the five-field DEFAULT_ROUTINE_SCHEDULE, so a pack
    // with anything else (an empty field, a six-field expression) would
    // prefill a schedule the create cannot use.
    for (const pack of ROUTINE_TEMPLATES) {
      const fields = pack.draft.schedule.trim().split(/\s+/);
      expect(fields).toHaveLength(5);
      expect(fields.every((field) => field.length > 0)).toBe(true);
    }
  });

  test('keys and labels are unique, so a row cannot pick the wrong pack', () => {
    const keys = ROUTINE_TEMPLATES.map((pack) => pack.key);
    const labels = ROUTINE_TEMPLATES.map((pack) => pack.label);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(labels).size).toBe(labels.length);
  });

  test('the catalogue ships the four packs D4 names', () => {
    expect(ROUTINE_TEMPLATES.map((pack) => pack.label)).toEqual(PACK_LABELS);
  });

  test("a pack's prefill names the pack that set it up", () => {
    // The title is what the routine row will read on the gateway, so it has
    // to be the pack's own name and not a blank the operator cannot place.
    for (const pack of ROUTINE_TEMPLATES) {
      expect(pack.draft.title).toBe(pack.label);
    }
  });
});

describe('routineTemplateByKey', () => {
  test('answers the pack its key names', () => {
    expect(routineTemplateByKey('server-watchdog')).toEqual(
      ROUTINE_TEMPLATES.find((pack) => pack.key === 'server-watchdog'),
    );
    for (const pack of ROUTINE_TEMPLATES) {
      expect(routineTemplateByKey(pack.key)).toBe(pack);
    }
  });

  test('a key that names no pack is undefined, not a blank pack', () => {
    expect(routineTemplateByKey('morning-brief')).toBeUndefined();
    expect(routineTemplateByKey('')).toBeUndefined();
    expect(routineTemplateByKey('MORNING-BRIEFING')).toBeUndefined();
  });
});

describe('applyRoutineTemplate', () => {
  test('overwrites all three fields of the draft', () => {
    const pack = routineTemplateByKey('inbox-triage');
    expect(pack).toBeDefined();
    if (!pack) return;
    const next = applyRoutineTemplate(MINE, 'inbox-triage');
    expect(next).toEqual(pack.draft);
    expect(next.title).not.toBe(MINE.title);
    expect(next.prompt).not.toBe(MINE.prompt);
    expect(next.schedule).not.toBe(MINE.schedule);
  });

  test('rules over a half-filled draft rather than merging with it', () => {
    // A merged draft would ship the pack's schedule over the operator's
    // stale title, or the other way round — a routine nobody wrote.
    const next = applyRoutineTemplate(
      { title: 'old', prompt: '', schedule: '0 0 * * *' },
      'weekly-code-review',
    );
    expect(next).toEqual(routineTemplateByKey('weekly-code-review')?.draft);
    expect(next.prompt.trim()).not.toBe('');
  });

  test('an empty draft comes back as the pack, not as blanks', () => {
    const next = applyRoutineTemplate({ title: '', prompt: '', schedule: '' }, 'morning-briefing');
    expect(next).toEqual(routineTemplateByKey('morning-briefing')?.draft);
  });

  test('leaves the draft alone for a key that names no pack', () => {
    // A tap that cannot resolve a pack must leave the form as it was, never
    // blank it.
    expect(applyRoutineTemplate(MINE, 'no-such-pack')).toEqual(MINE);
    expect(applyRoutineTemplate(MINE, 'no-such-pack').title).toBe('mine');
    expect(applyRoutineTemplate({ title: '', prompt: '', schedule: '' }, '')).toEqual({
      title: '',
      prompt: '',
      schedule: '',
    });
  });

  test('hands back a copy, so an edited draft cannot rewrite the catalogue', () => {
    // Otherwise the first tap-and-edit would change what every later tap of
    // the same pack starts from.
    const first = applyRoutineTemplate(MINE, 'morning-briefing');
    first.title = 'edited';
    expect(routineTemplateByKey('morning-briefing')?.draft.title).toBe('Morning briefing');
    expect(applyRoutineTemplate(MINE, 'morning-briefing')).not.toBe(
      applyRoutineTemplate(MINE, 'morning-briefing'),
    );
  });
});

describe('routines pane template rows', () => {
  test('renders one row per pack, above the create form', () => {
    const src = pane();
    expect(src).toContain("from '@/lib/gateway/routine-templates'");
    expect(src).toMatch(/ROUTINE_TEMPLATES\.map\(/);
    const templatesIdx = src.indexOf('ROUTINE_TEMPLATES.map(');
    const newRoutineIdx = src.indexOf('New routine');
    const addIdx = src.indexOf("label={creating ? 'Adding…' : 'Add'}");
    expect(templatesIdx).toBeGreaterThan(-1);
    expect(newRoutineIdx).toBeGreaterThan(templatesIdx);
    expect(addIdx).toBeGreaterThan(newRoutineIdx);
  });

  test('a pack tap writes the draft through the fold and never creates', () => {
    const src = pane();
    // The row hands the fold the operator's current draft and the pack's key.
    expect(src).toMatch(
      /applyRoutineTemplate\(\s*\{\s*title,\s*prompt,\s*schedule\s*\},\s*key\s*\)/,
    );
    // The tap writes the three fields it got back, one setter each.
    const fold = src.match(/const applyTemplate = \(key: string\) => \{[\s\S]*?\n {2}\};/)?.[0];
    expect(fold).toBeDefined();
    expect(fold).toContain('setTitle(next.title);');
    expect(fold).toContain('setPrompt(next.prompt);');
    expect(fold).toContain('setSchedule(next.schedule);');
    expect(fold).not.toContain('onCreate(');
  });

  test('Add stays the only call site of onCreate', () => {
    const src = pane();
    expect(src.match(/onCreate\(/g)).toHaveLength(1);
    const submit = src.match(/const submitCreate = \(\) => \{[\s\S]*?\n {2}\};/)?.[0];
    expect(submit).toBeDefined();
    expect(submit).toContain('onCreate(');
  });

  test('an empty schedule field still falls back to the default schedule', () => {
    const src = pane();
    expect(src).toMatch(/schedule: schedule\.trim\(\) \|\| DEFAULT_ROUTINE_SCHEDULE/);
  });

  test('the pack rows carry no trailing control of their own', () => {
    // A pack row is a draft, not an action: it must not grow the Pause
    // affordance the job rows carry.
    const src = pane();
    const row = src.match(/ROUTINE_TEMPLATES\.map\([\s\S]*?\n\s*\)\)\}/)?.[0];
    expect(row).toBeDefined();
    expect(row).toContain('subtitle={template.description}');
    expect(row).not.toContain('trailing=');
  });
});
