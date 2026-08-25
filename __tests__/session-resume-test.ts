import { APP_SESSION_SOURCE, pickAppSession } from '@/lib/gateway/messages';
import { RESUME_SESSION_PAGE, resolveResumeSession } from '@/lib/gateway/session-resume';
import type { HermesSession } from '@/lib/gateway/types';
import type { PortalClient } from '@/lib/portal/adapters';

type ResumeClient = Pick<PortalClient, 'getSessions' | 'createSession'>;

function session(id: string, source = APP_SESSION_SOURCE): HermesSession {
  return {
    id,
    source,
    user_id: null,
    model: null,
    title: null,
    started_at: 0,
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
    last_active: 0,
    preview: null,
    has_system_prompt: false,
    has_model_config: false,
  };
}

describe('resolveResumeSession — session pick + graceful degrade', () => {
  test('resumes the app’s own most recent session without creating a new one', async () => {
    const getSessions = jest.fn(async () => [
      session('foreign-tui', 'tui'),
      session('my-session'),
      session('old-api', APP_SESSION_SOURCE),
    ]);
    const createSession = jest.fn(async () => session('fresh'));
    const client: ResumeClient = { getSessions, createSession };

    const outcome = await resolveResumeSession(client);

    expect(outcome.sessionId).toBe('my-session');
    expect(outcome.sessions.map((s) => s.id)).toEqual(['foreign-tui', 'my-session', 'old-api']);
    expect(createSession).not.toHaveBeenCalled();
    expect(getSessions).toHaveBeenCalledWith(RESUME_SESSION_PAGE);
  });

  test('creates a fresh session when the gateway hosts no session this app owns', async () => {
    const getSessions = jest.fn(async () => [session('robot', 'cron')]);
    const createSession = jest.fn(async () => session('new-session'));
    const client: ResumeClient = { getSessions, createSession };

    const outcome = await resolveResumeSession(client);

    expect(outcome.sessionId).toBe('new-session');
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  test('degrades to stateless when the manifest advertises no sessions endpoint', async () => {
    // ManifestClient refuses to invent a path the manifest never advertised.
    const getSessions = jest.fn(async () => {
      throw new Error('Versutus Gate does not advertise session management');
    });
    const createSession = jest.fn(async () => {
      throw new Error('This gateway\'s manifest does not advertise a "sessions" endpoint.');
    });
    const client: ResumeClient = { getSessions, createSession };

    const outcome = await resolveResumeSession(client);

    expect(outcome.sessionId).toBeUndefined();
    expect(outcome.sessions).toEqual([]);
  });

  test('does not even demand a list when the client has no session surface at all', async () => {
    const getSessions = jest.fn(async () => []);
    const client: Pick<PortalClient, 'getSessions'> = { getSessions };

    const outcome = await resolveResumeSession(client);

    expect(outcome.sessionId).toBeUndefined();
    expect(getSessions).toHaveBeenCalledTimes(1);
  });

  test('still creates a session when a flaky list read fails but create works', async () => {
    const getSessions = jest.fn(async () => {
      throw new Error('temporary list failure');
    });
    const createSession = jest.fn(async () => session('recovered'));
    const client: ResumeClient = { getSessions, createSession };

    const outcome = await resolveResumeSession(client);

    expect(outcome.sessionId).toBe('recovered');
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  test('a gateway with no createSession stays stateless', async () => {
    const getSessions = jest.fn(async () => []);
    // Some adapters (e.g. Hermes probe path) always expose createSession, but
    // a minimal PortalClient is not required to — and the resume must not.
    const client: Pick<PortalClient, 'getSessions'> = { getSessions };

    const outcome = await resolveResumeSession(client);

    expect(outcome.sessionId).toBeUndefined();
  });

  test('the own-session marker the helper trusts is the same one pickAppSession reads', () => {
    // Guards against the helper and the picker drifting apart on the contract.
    const list = [session('a', 'tui'), session('b')];
    expect(pickAppSession(list)?.id).toBe('b');
  });
});
