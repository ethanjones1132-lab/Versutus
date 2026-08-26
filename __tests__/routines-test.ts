import {
  applyRoutineCreate,
  describeRoutineError,
  parseRoutineName,
  routineName,
} from '@/lib/gateway/routines';

test('routineName namespaces a job to a bot', () => {
  expect(routineName('researcher', 'inbox')).toBe('[bot:researcher] inbox');
  expect(parseRoutineName('[bot:researcher] inbox')).toEqual({ botId: 'researcher', title: 'inbox' });
  expect(parseRoutineName('plain')).toEqual({ title: 'plain' });
});

const INBOX_DRAFT = {
  title: 'inbox',
  prompt: 'Summarize overnight mail',
  schedule: '30 8 * * 1',
};

test('a refused routine create keeps the submitted fields and names why', () => {
  const next = applyRoutineCreate(INBOX_DRAFT, {
    ok: false,
    cause: new Error('bot "echo" has no API_SERVER_KEY'),
  });
  expect(next.draft).toEqual(INBOX_DRAFT);
  expect(next.error).toContain('Bot has no listen key');
  expect(next.error).toContain('bot "echo" has no API_SERVER_KEY');
});

test('an accepted routine create empties title and prompt, keeps the schedule, and is silent', () => {
  const next = applyRoutineCreate(INBOX_DRAFT, { ok: true });
  expect(next.draft).toEqual({ title: '', prompt: '', schedule: '30 8 * * 1' });
  expect(next.error).toBeUndefined();
});

test('describeRoutineError classifies a listen-key refusal the same way other surfaces do', () => {
  const shown = describeRoutineError(new Error('bot "writer" has no API_SERVER_KEY'));
  expect(shown).toContain('Bot has no listen key');
  expect(shown).toContain('bot "writer" has no API_SERVER_KEY');
  expect(shown).toContain("Set API_SERVER_KEY in the profile's .env on the host, then retry.");
});

test('describeRoutineError keeps unclassifiable refusals raw', () => {
  expect(describeRoutineError(new Error('cron already exists'))).toBe('cron already exists');
  expect(describeRoutineError('This gateway does not manage jobs.')).toBe(
    'This gateway does not manage jobs.',
  );
});

test('describeRoutineError accepts Error instances and plain strings alike', () => {
  expect(describeRoutineError(new Error('cron already exists'))).toBe('cron already exists');
  expect(describeRoutineError('cron already exists')).toBe('cron already exists');
});

