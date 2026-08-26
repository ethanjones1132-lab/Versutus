import { botRoutingView, describeBotDetail } from '@/lib/gateway/bot-detail';
import { applyBotSoulRead, botSoulCopy, botSoulReadFromUnknown } from '@/lib/gateway/bots';

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
  expect(view.messagable).toBe(true);
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

test('named bots are offered the edit affordance; default never is', () => {
  // The Gate refuses every write against "default" (ADR 0011 — it is not a
  // bot), so the sheet hides Edit there instead of inviting a guaranteed
  // refusal. Every roster id came from this same Gate list, so id is the
  // whole decision.
  expect(describeBotDetail({ id: 'coder', displayName: 'Coder', routable: true }).editable).toBe(true);
  expect(
    describeBotDetail({ id: 'default', displayName: 'Default', routable: true }).editable,
  ).toBe(false);
});

test('Bots without a route get no message affordance', () => {
  // The sheet shows the routing verdict and its fix directly above where a
  // Message row would sit — offering the row there invites a send the Gate
  // has already refused. A reported issue wins over a stale routable:true,
  // matching the verdict the surface itself renders.
  expect(
    describeBotDetail({ id: 'nokey', displayName: 'NoKey', routable: false }).messagable,
  ).toBe(false);
  expect(
    describeBotDetail({
      id: 'refused',
      displayName: 'Refused',
      routable: true,
      routingIssue: 'default_key_refused',
    }).messagable,
  ).toBe(false);
  expect(
    describeBotDetail({
      id: 'missing',
      displayName: 'Missing',
      routable: true,
      routingIssue: 'listen_key_missing',
    }).messagable,
  ).toBe(false);
});

test('the default profile is messagable even though it is not editable', () => {
  // Two independent guards: Edit hides because ADR 0011 refuses writes to
  // "default"; Message stays because chatting with the default agent is a
  // real, supported path.
  const view = describeBotDetail({ id: 'default', displayName: 'Default', routable: true });
  expect(view.messagable).toBe(true);
  expect(view.editable).toBe(false);
});

test('the detail sheet names multiplex as the fix, not the key', () => {
  const view = botRoutingView({ routable: false, routingIssue: 'multiplex_disabled' });
  expect(view.title).toBe('Multiplex is off');
  expect(view.next).toMatch(/multiplex_profiles/);
  // A Bot the host cannot address is not messagable, same as the other issues.
  expect(
    describeBotDetail({
      id: 'anvil',
      displayName: 'anvil',
      routable: false,
      routingIssue: 'multiplex_disabled',
    }).messagable,
  ).toBe(false);
});

// A soul is read per-Bot, so the three states the operator can be in must stay
// distinct: it has one, it genuinely has none, or we could not read it. The
// third must never render as the second — that is the empty-vs-failed lie.
describe('a Bot soul read', () => {
  const fresh = { soul: null, loaded: false, failed: false };

  test('a read that returns a soul shows it', () => {
    const state = applyBotSoulRead(fresh, { ok: true, soul: 'You are precise.' });
    expect(state).toEqual({ soul: 'You are precise.', loaded: true, failed: false });
    expect(botSoulCopy(state)).toBeUndefined();
  });

  test('a Bot with genuinely no soul says so', () => {
    const state = applyBotSoulRead(fresh, { ok: true, soul: null });
    expect(state).toEqual({ soul: null, loaded: true, failed: false });
    expect(botSoulCopy(state)).toBe('No standing instructions.');
  });

  test('a failed first read says it could not be read, not that there is none', () => {
    const state = applyBotSoulRead(fresh, { ok: false });
    expect(state.loaded).toBe(false);
    expect(state.failed).toBe(true);
    expect(botSoulCopy(state)).toBe('The soul could not be read.');
  });

  test('a failed re-read keeps the soul already on screen', () => {
    const had = applyBotSoulRead(fresh, { ok: true, soul: 'You are precise.' });
    const state = applyBotSoulRead(had, { ok: false });
    expect(state.soul).toBe('You are precise.');
    expect(botSoulCopy(state)).toBe('Could not re-read the soul — showing the last one.');
  });
});

describe('parsing a bots.get payload', () => {
  test('a Bot carrying a soul reads as that soul', () => {
    expect(botSoulReadFromUnknown({ id: 'researcher', soul: 'You are precise.' }))
      .toEqual({ ok: true, soul: 'You are precise.' });
  });

  test('a Bot reporting soul: null genuinely has none', () => {
    expect(botSoulReadFromUnknown({ id: 'researcher', soul: null }))
      .toEqual({ ok: true, soul: null });
  });

  test('an older Gate that omits soul entirely is a failed read, not an empty one', () => {
    // The field is always present on a Gate that serves bots.get. Absent means
    // this host cannot answer — saying "no standing instructions" would invent
    // a fact about the Bot from a fact about the Gate.
    expect(botSoulReadFromUnknown({ id: 'researcher', displayName: 'Researcher' }))
      .toEqual({ ok: false });
  });

  test('a junk envelope is a failed read', () => {
    expect(botSoulReadFromUnknown(null)).toEqual({ ok: false });
    expect(botSoulReadFromUnknown('nope')).toEqual({ ok: false });
    expect(botSoulReadFromUnknown({ soul: 42 })).toEqual({ ok: false });
  });
});
