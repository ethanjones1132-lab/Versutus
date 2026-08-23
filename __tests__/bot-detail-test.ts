import { botRoutingView, describeBotDetail } from '@/lib/gateway/bot-detail';

// The detail surface is the roster row's "who is this and why can't it
// route". Every verdict string below is shared with the run-failure
// vocabulary (run-failures.ts) and pinned here so the sheet can never drift
// from what a failed send says for the same host state.

test('describeBotDetail renders the full Gate payload', () => {
  const view = describeBotDetail({
    id: 'researcher',
    displayName: 'Researcher',
    routable: true,
    description: 'Runs long research tasks',
    model: { default: 'anthropic/claude-sonnet-4', provider: 'kilo' },
  });
  expect(view.name).toBe('Researcher');
  expect(view.id).toBe('researcher');
  expect(view.description).toBe('Runs long research tasks');
  expect(view.modelPin).toBe('anthropic/claude-sonnet-4 · kilo');
  expect(view.routingTitle).toBe('Routable');
  expect(view.routingNext).toBeUndefined();
});

test('absent fields degrade to nulls, never invented text', () => {
  const view = describeBotDetail({ id: 'plain', displayName: 'plain', routable: true });
  expect(view.description).toBeNull();
  expect(view.modelPin).toBeNull();
  // Explicit nulls (older Gates report null) behave the same as absent.
  const nulled = describeBotDetail({
    id: 'old',
    displayName: 'old',
    routable: true,
    description: null,
    model: null,
  });
  expect(nulled.description).toBeNull();
  expect(nulled.modelPin).toBeNull();
});

test('model pin shows partial pins instead of collapsing them away', () => {
  // Provider-only pin is real information on the detail surface even though
  // the roster subtitle hides it behind plain "Bot".
  expect(
    describeBotDetail({
      id: 'pinned-provider',
      displayName: 'pp',
      routable: true,
      model: { default: null, provider: 'kilo' },
    }).modelPin,
  ).toBe('kilo');
  expect(
    describeBotDetail({
      id: 'pinned-default',
      displayName: 'pd',
      routable: true,
      model: { default: 'z-ai/glm-5.2', provider: null },
    }).modelPin,
  ).toBe('z-ai/glm-5.2');
  // Empty strings are not pins.
  expect(
    describeBotDetail({
      id: 'blank',
      displayName: 'blank',
      routable: true,
      model: { default: '', provider: '' },
    }).modelPin,
  ).toBeNull();
});

test('routing verdict reuses the run-failure fix for a missing key', () => {
  const view = botRoutingView({ routable: false, routingIssue: 'listen_key_missing' });
  expect(view.title).toBe('Bot has no listen key');
  expect(view.next).toContain("Set API_SERVER_KEY in the profile's .env");
});

test('routing verdict names the distinct default-key refusal and its fix', () => {
  const view = botRoutingView({ routable: false, routingIssue: 'default_key_refused' });
  expect(view.title).toBe('Bot listen key refused');
  expect(view.next).toContain("own API_SERVER_KEY");
});

test('routingIssue wins over a stale routable boolean, mirroring the roster row', () => {
  expect(
    botRoutingView({ routable: true, routingIssue: 'default_key_refused' }).title,
  ).toBe('Bot listen key refused');
  expect(
    botRoutingView({ routable: true, routingIssue: 'listen_key_missing' }).title,
  ).toBe('Bot has no listen key');
});

test('older Gates without routingIssue degrade on the boolean alone', () => {
  expect(botRoutingView({ routable: false }).title).toBe('Bot has no listen key');
  expect(botRoutingView({ routable: true }).title).toBe('Routable');
});
