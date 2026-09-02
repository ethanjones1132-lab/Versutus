import { APP_SESSION_SOURCE, pickAppSession } from '@/lib/gateway/messages';
import { liveSessionId, pinLiveSession, RESUME_SESSION_PAGE, resolveResumeSession } from '@/lib/gateway/session-resume';
import type { GatewayProfile, HermesSession } from '@/lib/gateway/types';
import type { PortalClient } from '@/lib/portal/adapters';

type ResumeClient = Pick<PortalClient, 'getSessions' | 'createSession' | 'canManageSessions'>;

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

  test('does not list or create when the client advertises no session capability', async () => {
    const getSessions = jest.fn(async () => [session('unexpected')]);
    const createSession = jest.fn(async () => session('unexpected-create'));
    const client: ResumeClient = { canManageSessions: false, getSessions, createSession };

    const outcome = await resolveResumeSession(client);

    expect(outcome.sessionId).toBeUndefined();
    expect(outcome.sessions).toEqual([]);
    expect(getSessions).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  test('does not even demand a list when the client has no session surface at all', async () => {
    const getSessions = jest.fn(async () => []);
    const client: Pick<PortalClient, 'getSessions'> = { getSessions };

    const outcome = await resolveResumeSession(client);

    expect(outcome.sessionId).toBeUndefined();
    expect(getSessions).toHaveBeenCalledTimes(1);
  });

  test('does not create a session when a flaky list read fails', async () => {
    const getSessions = jest.fn(async () => {
      throw new Error('temporary list failure');
    });
    const createSession = jest.fn(async () => session('recovered'));
    const client: ResumeClient = { getSessions, createSession };

    const outcome = await resolveResumeSession(client);

    expect(outcome.sessionId).toBeUndefined();
    expect(outcome.sessions).toEqual([]);
    expect(createSession).not.toHaveBeenCalled();
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

describe('liveSessionId — stored is a reconnect pin, not a live thread', () => {
  test('an open thread reloads itself even when the profile remembers another', () => {
    expect(liveSessionId({ live: 'ses_open', stored: 'ses_old' })).toBe('ses_open');
  });

  test('a deliberate release does not restore the previous session from the profile', () => {
    // selectBackend clears the live slot then reloads. The old `live ?? stored`
    // fallback immediately resurrected the previous CLI environment's session:
    // history loaded it (or a 404 looked empty) and the next send still
    // carried that id.
    expect(liveSessionId({ live: undefined, stored: 'ses_old' })).toBeUndefined();
  });

  test('connect copies stored onto live first, so a reconnect still resumes', () => {
    // connectGateway assigns sessionIdRef from the profile before the first
    // history load. After that, live is stored — the helper never has to
    // fall back to the profile itself.
    expect(liveSessionId({ live: 'ses_remembered', stored: 'ses_remembered' })).toBe('ses_remembered');
  });

  test('an empty live slot with nothing stored stays empty', () => {
    expect(liveSessionId({ live: undefined, stored: undefined })).toBeUndefined();
    expect(liveSessionId({ live: '  ', stored: 'ses_old' })).toBeUndefined();
  });
});

describe('pinLiveSession — a new session is still current after reconnect', () => {
  function pinClient(initial?: string) {
    let current = initial;
    return {
      get sessionId() {
        return current;
      },
      setSessionId(id: string | undefined) {
        current = id;
      },
    };
  }

  const profile = (sessionId?: string): GatewayProfile => ({
    id: 'g1',
    name: 'Test gateway',
    url: 'http://gateway.test:8760',
    kind: 'custom',
    createdAt: 0,
    sessionId,
  });

  test('pins the client so disconnect writes the new session, not the previous one', () => {
    // Gate createSession never assigns currentSessionId. Hermes native does.
    // ManifestClient.disconnect copies currentSessionId onto the profile pin,
    // so a New session that only updated React state reconnects as the old
    // thread and orphans the new one in the list.
    const client = pinClient('ses_old');
    pinLiveSession({ client, sessionId: 'ses_new', profile: profile('ses_old') });
    expect(client.sessionId).toBe('ses_new');
  });

  test('writes the reconnect pin onto a new profile so connect copies the new session onto live', () => {
    const client = pinClient('ses_old');
    const previous = profile('ses_old');
    const next = pinLiveSession({ client, sessionId: 'ses_new', profile: previous });
    expect(next?.sessionId).toBe('ses_new');
    expect(previous.sessionId).toBe('ses_old');
    // connectGateway assigns sessionIdRef from the profile before the first
    // history load. Without this write, that assignment restores ses_old
    // even after the client was pinned — disconnect runs too late to help.
    expect(liveSessionId({ live: next?.sessionId, stored: next?.sessionId })).toBe('ses_new');
  });

  test('a New session that is not pinned reconnects as the previous thread', () => {
    // The hole: createNewSession wrote sessionIdRef and React state, never
    // the client or the profile. connectGateway then copied stored onto live.
    expect(liveSessionId({ live: 'ses_old', stored: 'ses_old' })).toBe('ses_old');
  });

  test('a list pick that persists the reconnect pin is the session connect copies onto live', () => {
    // selectSession used to call setSessionId only. connectGateway copies
    // stored onto live before attachClient disconnects, so a pick then
    // background/reconnect restored whichever session New session (or the
    // last persist) wrote — not the one just picked.
    const client = pinClient('ses_old');
    const stored = profile('ses_from_new_session');
    const next = pinLiveSession({ client, sessionId: 'ses_picked', profile: stored });
    expect(client.sessionId).toBe('ses_picked');
    expect(next?.sessionId).toBe('ses_picked');
    expect(stored.sessionId).toBe('ses_from_new_session');
    expect(liveSessionId({ live: next?.sessionId, stored: next?.sessionId })).toBe('ses_picked');
  });

  test('a Bot Chat that persists the reconnect pin is the session connect copies onto live', () => {
    // openBot used to call setSessionId only. connectGateway copies stored
    // onto live before attachClient disconnects, so tapping a Bot then
    // background/reconnect restored whichever session New session or a list
    // pick last persisted — not that Bot Chat.
    const client = pinClient('ses_old');
    const stored = profile('ses_from_new_session');
    const next = pinLiveSession({ client, sessionId: 'ses_bot_chat', profile: stored });
    expect(client.sessionId).toBe('ses_bot_chat');
    expect(next?.sessionId).toBe('ses_bot_chat');
    expect(stored.sessionId).toBe('ses_from_new_session');
    expect(liveSessionId({ live: next?.sessionId, stored: next?.sessionId })).toBe('ses_bot_chat');
  });

  test('an already-pinned profile is the same object so the caller skips persist', () => {
    const client = pinClient();
    const previous = profile('ses_new');
    const next = pinLiveSession({ client, sessionId: 'ses_new', profile: previous });
    expect(next).toBe(previous);
    expect(client.sessionId).toBe('ses_new');
  });

  test('pins the client even when there is no profile to persist', () => {
    const client = pinClient('ses_old');
    expect(pinLiveSession({ client, sessionId: 'ses_new' })).toBeUndefined();
    expect(client.sessionId).toBe('ses_new');
  });

  test('whitespace is not a live session', () => {
    const client = pinClient('ses_old');
    const next = pinLiveSession({ client, sessionId: '  ', profile: profile('ses_old') });
    expect(client.sessionId).toBeUndefined();
    expect(next?.sessionId).toBeUndefined();
  });

  test('a model change that persists an empty pin reconnects without the old session', () => {
    // After /model set or a picker pick, the live session is released so the
    // next send opens one pinned to the new model. connectGateway copies
    // stored onto live before disconnect, so leaving the old sessionId on
    // the profile would restore that thread (and its old model) on reconnect.
    const client = pinClient('ses_old_model');
    const stored = profile('ses_old_model');
    const next = pinLiveSession({ client, sessionId: undefined, profile: stored });
    expect(client.sessionId).toBeUndefined();
    expect(next?.sessionId).toBeUndefined();
    expect(stored.sessionId).toBe('ses_old_model');
    expect(liveSessionId({ live: next?.sessionId, stored: next?.sessionId })).toBeUndefined();
  });
});
