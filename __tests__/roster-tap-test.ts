import type { PublicBot } from '@/lib/gateway/bots';
import { botReportedRoutable, rosterBotTap } from '@/lib/gateway/roster-tap';

function bot(overrides: Partial<PublicBot> = {}): PublicBot {
  return { id: 'researcher', displayName: 'researcher', routable: true, ...overrides };
}

type Spies = { chat: number; detail: number };

function tap(
  subject: Pick<PublicBot, 'routable' | 'routingIssue'>,
  withDetail = true,
): { press: (() => void) | undefined; spies: Spies } {
  const spies: Spies = { chat: 0, detail: 0 };
  const press = rosterBotTap(subject, {
    onChat: () => spies.chat++,
    onDetail: withDetail ? () => spies.detail++ : undefined,
  });
  return { press, spies };
}

test('a routable row opens the chat, never the detail sheet', () => {
  const { press, spies } = tap(bot());
  expect(press).toBeDefined();
  press?.();
  expect(spies.chat).toBe(1);
  expect(spies.detail).toBe(0);
});

test('an unroutable row hands over to the detail surface that names the fix', () => {
  const { press, spies } = tap(bot({ routable: false }));
  expect(press).toBeDefined();
  press?.();
  expect(spies.detail).toBe(1);
  expect(spies.chat).toBe(0);
});

test('a reported routing issue outranks a stale routable boolean', () => {
  // The Gate reports why the bot cannot route; trusting the old boolean here
  // would open a chat whose first send fails — the exact mismatch
  // describeBotDetail already refuses via messagable.
  for (const routingIssue of ['listen_key_missing', 'default_key_refused'] as const) {
    const { press, spies } = tap(bot({ routable: true, routingIssue }));
    press?.();
    expect(spies.detail).toBe(1);
    expect(spies.chat).toBe(0);

    const verdict = botReportedRoutable(bot({ routable: true, routingIssue }));
    expect(verdict).toBe(false);
  }
});

test('a null routing issue degrades to the plain boolean', () => {
  expect(botReportedRoutable(bot({ routable: true, routingIssue: null }))).toBe(true);
  expect(botReportedRoutable(bot({ routable: false, routingIssue: null }))).toBe(false);
});

test('without a detail surface an unroutable press stays undefined, not silent motion', () => {
  const { press, spies } = tap(bot({ routable: false }), false);
  expect(press).toBeUndefined();
  expect(spies.chat).toBe(0);
  expect(spies.detail).toBe(0);
});
