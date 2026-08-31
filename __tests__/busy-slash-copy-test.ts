import { decideBusySlash } from '@/lib/gateway/busy-slash';

describe('decideBusySlash while no command is running', () => {
  test('maps to the normal run shape so the command still executes', () => {
    const decision = decideBusySlash('/help', false, null);
    expect(decision).toEqual({ kind: 'run' });
  });

  test('ignores a stale running-command label when not busy', () => {
    const decision = decideBusySlash('/help', false, '/run');
    expect(decision).toEqual({ kind: 'run' });
  });
});

describe('decideBusySlash while a command is running', () => {
  test('maps to a busy note that names the unsent input', () => {
    const decision = decideBusySlash('/help', true, null);
    expect(decision.kind).toBe('busy');
    if (decision.kind === 'busy') {
      expect(decision.note).toMatch(/\/help was not sent/);
      expect(decision.note).toMatch(/still running/);
      expect(decision.note).toMatch(/send it again/);
    }
  });

  test('names the running command when its label is known', () => {
    const decision = decideBusySlash('/help', true, '/run');
    expect(decision.kind).toBe('busy');
    if (decision.kind === 'busy') {
      expect(decision.note).toMatch(/\(\/run\)/);
    }
  });

  test('does not invent a command name when the label is unknown', () => {
    const decision = decideBusySlash('/help', true, null);
    expect(decision.kind).toBe('busy');
    if (decision.kind === 'busy') {
      expect(decision.note).not.toMatch(/\(/);
    }
  });

  test('echoes the trimmed input even when the composer left whitespace', () => {
    const decision = decideBusySlash('  /help  ', true, '/run');
    expect(decision.kind).toBe('busy');
    if (decision.kind === 'busy') {
      expect(decision.note).toMatch(/^\/help was not sent/);
    }
  });
});