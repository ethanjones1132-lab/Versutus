import { botTap } from '@/lib/fleet/bot-tap';

// The helpers never lie about what they hand back, so the tests do not
// either: where the call may be `undefined` (no detail handler in play),
// the non-null assertion names itself rather than hiding behind an `!`.
describe('the fleet constellation Bot tap', () => {
  test('a Bot on a disconnected gateway opens the roster detail, not a chat', () => {
    const calls: string[] = [];
    const open = botTap(
      { connected: false },
      { id: 'claude-bot' },
      { onChat: () => calls.push('chat'), onDetail: () => calls.push('detail') },
    );
    expect(open).toBeDefined();
    open!();
    expect(calls).toEqual(['detail']);
  });

  test('a routable Bot on the connected gateway opens its chat', () => {
    const calls: string[] = [];
    const open = botTap(
      { connected: true },
      { id: 'claude-bot', routable: true, routingIssue: null },
      { onChat: () => calls.push('chat'), onDetail: () => calls.push('detail') },
    );
    expect(open).toBeDefined();
    open!();
    expect(calls).toEqual(['chat']);
  });

  test('a connected Bot the Gate names an issue for opens the detail naming why, not a chat', () => {
    for (const routingIssue of [
      'listen_key_missing',
      'multiplex_disabled',
      'default_key_refused',
    ] as const) {
      const calls: string[] = [];
      const open = botTap(
        { connected: true },
        { id: 'claude-bot', routable: true, routingIssue },
        { onChat: () => calls.push('chat'), onDetail: () => calls.push('detail') },
      );
      expect(open).toBeDefined();
      open!();
      expect(calls).toEqual(['detail']);
    }
  });

  test('a connected Bot the Gate only calls unroutable (older Gate) opens the detail too', () => {
    const calls: string[] = [];
    const open = botTap(
      { connected: true },
      { id: 'claude-bot', routable: false },
      { onChat: () => calls.push('chat'), onDetail: () => calls.push('detail') },
    );
    expect(open).toBeDefined();
    open!();
    expect(calls).toEqual(['detail']);
  });

  test('a Bot with no detail handler routed to a disconnected tap stays undefined', () => {
    expect(
      botTap(
        { connected: false },
        { id: 'claude-bot' },
        {
          onChat: () => undefined,
          // No detail handler: older callers, like roster-tap's undefined.
        },
      ),
    ).toBeUndefined();
  });
});
