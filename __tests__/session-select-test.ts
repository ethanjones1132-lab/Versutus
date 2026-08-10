import { APP_SESSION_SOURCE, pickAppSession } from '@/lib/gateway/messages';
import type { HermesSession } from '@/lib/gateway/types';

function session(id: string, source: string): HermesSession {
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
  } as HermesSession;
}

describe('picking the session the app should resume', () => {
  test('skips the desktop TUI session even when it is newest', () => {
    // Mirrors the live gateway: newest is a TUI conversation from the desktop.
    const sessions = [
      session('20260810_162015_03f61a', 'tui'),
      session('api_1786391926_8bcf81bf', APP_SESSION_SOURCE),
      session('20260810_154856_e1c5d0', 'discord'),
    ];
    expect(pickAppSession(sessions)?.id).toBe('api_1786391926_8bcf81bf');
  });

  test('ignores cron and discord sessions', () => {
    const sessions = [session('c1', 'cron'), session('d1', 'discord')];
    expect(pickAppSession(sessions)).toBeUndefined();
  });

  test('takes the newest app session when several exist', () => {
    const sessions = [
      session('newest', APP_SESSION_SOURCE),
      session('older', APP_SESSION_SOURCE),
    ];
    expect(pickAppSession(sessions)?.id).toBe('newest');
  });

  test('returns nothing for an empty gateway so a fresh session is created', () => {
    expect(pickAppSession([])).toBeUndefined();
  });
});
