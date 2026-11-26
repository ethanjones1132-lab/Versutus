// The roster row, member chip and Details sheet must never disagree about why
// a Bot cannot route. This pins that the two roster helpers take their verdict
// from botRoutingView instead of re-deriving the precedence themselves: the
// mocked view answers, so a hand-written copy inside bots.ts would ignore it
// and fail these expectations.
jest.mock('@/lib/gateway/bot-detail', () => ({
  botRoutingView: jest.fn(),
}));

import { botRoutingView } from '@/lib/gateway/bot-detail';
import { botChipRoutingTag, botRowSubtitle } from '@/lib/gateway/bots';

const routingView = botRoutingView as jest.Mock;

beforeEach(() => {
  routingView.mockReset();
});

test('the roster row takes its routing verdict from botRoutingView', () => {
  routingView.mockReturnValue({ title: 'Routable', issue: null });
  expect(botRowSubtitle({ id: 'x', displayName: 'x', routable: false })).toBe('Bot');
});

test('the roster row keeps its own one-line copy for the issue the view names', () => {
  routingView.mockReturnValue({
    title: 'Bot has no listen key',
    next: "Set API_SERVER_KEY in the profile's .env on the host, then retry.",
    issue: 'listen_key_missing',
  });
  expect(botRowSubtitle({ id: 'x', displayName: 'x', routable: true })).toBe('Not set up yet');

  routingView.mockReturnValue({
    title: 'Multiplex is off',
    next: 'Enable multiplex on the host.',
    issue: 'multiplex_disabled',
  });
  expect(botRowSubtitle({ id: 'x', displayName: 'x', routable: true })).toBe('Multiplex is off');
});

test('the member chip stays silent only when botRoutingView says routable', () => {
  routingView.mockReturnValue({ title: 'Routable', issue: null });
  expect(botChipRoutingTag({ id: 'x', displayName: 'x', routable: false })).toBe('');

  routingView.mockReturnValue({ title: 'Bot listen key refused', next: 'fix', issue: 'default_key_refused' });
  expect(botChipRoutingTag({ id: 'x', displayName: 'x', routable: true })).toBe('Not set up yet');
});
