import { canServeModel, resolveResumeSession } from '@/lib/gateway/session-resume';
import type { HermesSession } from '@/lib/gateway/types';

const session = (overrides: Partial<HermesSession> = {}): HermesSession => ({
  id: 'api_1',
  source: 'api_server',
  user_id: null,
  model: null,
  title: 'Versutus',
  started_at: 1,
  ended_at: null,
  end_reason: null,
  message_count: 0,
  tool_call_count: 0,
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  reasoning_tokens: 0,
  estimated_cost_usd: null,
  actual_cost_usd: null,
  api_call_count: 0,
  parent_session_id: null,
  last_active: 1,
  preview: null,
  has_system_prompt: false,
  has_model_config: false,
  ...overrides,
});

describe('canServeModel', () => {
  test('a session pinned to another model cannot serve the requested one', () => {
    // The real case: one app session opened days earlier and frozen on
    // dots-3-note-preview, while the operator had since chosen laguna.
    expect(canServeModel(session({ model: 'dots-studio/dots-3-note-preview:free' }), 'opencode-zen/laguna-s-2.1-free'))
      .toBe(false);
  });

  test('the same model written two ways is not a mismatch', () => {
    // The app carries `provider/model`; a session records whichever form its
    // creator used. A raw compare would throw away a perfectly good session.
    expect(canServeModel(session({ model: 'laguna-s-2.1-free' }), 'opencode-zen/laguna-s-2.1-free')).toBe(true);
    expect(canServeModel(session({ model: 'opencode-zen/laguna-s-2.1-free' }), 'laguna-s-2.1-free')).toBe(true);
    expect(
      canServeModel(
        session({ model: 'poolside/laguna-xs-2.1:free' }),
        'nous/poolside/laguna-xs-2.1:free',
      ),
    ).toBe(true);
  });

  test('wanting no particular model keeps whatever session exists', () => {
    // A Bot sends no model — it answers as itself — and must keep its history.
    expect(canServeModel(session({ model: 'anything' }), undefined)).toBe(true);
  });

  test('a session with no model recorded is not a mismatch', () => {
    expect(canServeModel(session({ model: null }), 'opencode-zen/laguna-s-2.1-free')).toBe(true);
  });
});

describe('resolveResumeSession', () => {
  const client = (sessions: HermesSession[], created = 'api_new') => {
    const calls: { model?: string }[] = [];
    return {
      calls,
      getSessions: async () => sessions,
      createSession: async (_title?: string, model?: string) => {
        calls.push({ model });
        return session({ id: created, model: model ?? null });
      },
    };
  };

  test('resumes the app session when its model can serve the request', async () => {
    const c = client([session({ id: 'api_keep', model: 'laguna-s-2.1-free' })]);
    const outcome = await resolveResumeSession(c, 'opencode-zen/laguna-s-2.1-free');
    expect(outcome.sessionId).toBe('api_keep');
    expect(c.calls).toHaveLength(0);
  });

  test('opens a new pinned session rather than resuming a mismatched one', async () => {
    // Without this the operator's model pick could never take effect: the old
    // session answered every turn while the picker showed the new choice.
    const c = client([session({ id: 'api_old', model: 'dots-studio/dots-3-note-preview:free' })]);
    const outcome = await resolveResumeSession(c, 'opencode-zen/laguna-s-2.1-free');
    expect(outcome.sessionId).toBe('api_new');
    expect(c.calls).toEqual([{ model: 'opencode-zen/laguna-s-2.1-free' }]);
  });

  test('still degrades to stateless when the gateway cannot create sessions', async () => {
    const outcome = await resolveResumeSession(
      { getSessions: async () => [], createSession: undefined },
      'opencode-zen/laguna-s-2.1-free',
    );
    expect(outcome.sessionId).toBeUndefined();
  });

  test('a failed create leaves stateless chat rather than throwing', async () => {
    const outcome = await resolveResumeSession({
      getSessions: async () => [],
      createSession: async () => { throw new Error('refused'); },
    });
    expect(outcome.sessionId).toBeUndefined();
  });
});
