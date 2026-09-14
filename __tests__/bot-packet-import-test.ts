// The read-back contract: what a picked packet text answers, and what the
// gateway verdict says about it. Written against the spec's validate-first
// rule (FUTURE-ITEMS.md:309-313), not against whatever the code emits.

import {
  BOT_PACKET_EXCLUDED_COPY,
  BOT_PACKET_KIND,
  BOT_PACKET_VERSION,
  buildBotPacket,
  type BotPacket,
} from '../src/lib/gateway/bot-packet';
import {
  BOT_PACKET_IMPORT_REFUSAL_COPY,
  botPacketVerdictCopy,
  parseBotPacket,
  validateBotPacketAgainstGateway,
} from '../src/lib/gateway/bot-packet-import';

const GOOD_PACKET: BotPacket = {
  version: BOT_PACKET_VERSION,
  kind: BOT_PACKET_KIND,
  bot: { name: 'Scout' },
  soul: 'Stay sharp.',
  modelPin: 'nous/poolside/laguna-xs-2.1:free',
  trust: { fields: ['soul', 'description', 'model pin'], excluded: ['memory', 'credentials'] },
};

describe('parseBotPacket', () => {
  it('parses what the export half emits, round-trip', () => {
    const exported = buildBotPacket(
      { displayName: 'Scout', description: 'a scout', model: { default: 'laguna', provider: 'nous' } },
      { loaded: true, failed: false, soul: 'Stay sharp.' },
    );
    const parsed = parseBotPacket(JSON.stringify(exported));
    expect(parsed).toEqual({ ok: true, packet: exported });
  });

  it('accepts a packet with optional fields absent', () => {
    const parsed = parseBotPacket(
      JSON.stringify({
        version: BOT_PACKET_VERSION,
        kind: BOT_PACKET_KIND,
        bot: { name: 'Scout' },
        trust: { fields: ['soul'], excluded: ['memory'] },
      }),
    );
    expect(parsed).toEqual({
      ok: true,
      packet: {
        version: BOT_PACKET_VERSION,
        kind: BOT_PACKET_KIND,
        bot: { name: 'Scout' },
        trust: { fields: ['soul'], excluded: ['memory'] },
      },
    });
  });

  it.each([
    ['not-json', 'not json at all {{'],
    ['wrong-version', JSON.stringify({ ...GOOD_PACKET, version: BOT_PACKET_VERSION + 1 })],
    ['wrong-kind', JSON.stringify({ ...GOOD_PACKET, kind: 'something-else' })],
    ['no-bot', JSON.stringify({ ...GOOD_PACKET, bot: 7 })],
    ['no-name', JSON.stringify({ ...GOOD_PACKET, bot: { name: '   ' } })],
    [
      'wrong-shape',
      JSON.stringify({ version: BOT_PACKET_VERSION, kind: BOT_PACKET_KIND, trust: 4, bot: { name: 'x' } }),
    ],
    [
      'wrong-shape',
      JSON.stringify({ ...GOOD_PACKET, soul: 5 }),
    ],
    [
      'wrong-shape',
      JSON.stringify({ ...GOOD_PACKET, modelPin: 5 }),
    ],
  ] as const)('refuses %s with its honest sentence', (reason, text) => {
    const parsed = parseBotPacket(text);
    expect(parsed).toEqual({ ok: false, reason });
    expect(BOT_PACKET_IMPORT_REFUSAL_COPY[reason]).toBeTruthy();
  });
});

describe('validateBotPacketAgainstGateway', () => {
  const catalog = [
    { id: 'nous/poolside/laguna-xs-2.1:free' },
    { id: 'openai/gpt-5-mini' },
  ];

  it('answers matched for a pin the gateway serves, under sameModelId tolerance', () => {
    // The packet pins the full send id; the catalog carries it qualified —
    // the inverse also matches via the same fold the send path uses.
    expect(validateBotPacketAgainstGateway(GOOD_PACKET, catalog)).toEqual({ model: 'matched' });
    expect(
      validateBotPacketAgainstGateway(
        { ...GOOD_PACKET, modelPin: 'laguna-xs-2.1:free' },
        catalog,
      ),
    ).toEqual({ model: 'matched' });
  });

  it('answers unknown, never fatal, for a pin the gateway does not serve', () => {
    expect(
      validateBotPacketAgainstGateway({ ...GOOD_PACKET, modelPin: 'nonsense/model' }, catalog),
    ).toEqual({ model: 'unknown' });
  });

  it('answers absent when the packet carries no pin', () => {
    expect(
      validateBotPacketAgainstGateway({ ...GOOD_PACKET, modelPin: undefined }, []),
    ).toEqual({ model: 'absent' });
  });
});

describe('botPacketVerdictCopy', () => {
  it('names what would land and re-asserts the trust line in the import direction', () => {
    const copy = botPacketVerdictCopy(
      GOOD_PACKET,
      validateBotPacketAgainstGateway(GOOD_PACKET, [
        { id: 'nous/poolside/laguna-xs-2.1:free' },
      ]),
    );
    expect(copy).toContain('Read Bot "Scout".');
    expect(copy).toContain('Standing instructions carried.');
    expect(copy).toContain('matches a model this gateway serves');
    expect(copy).toContain('Nothing is applied by reading it back.');
    expect(copy).toContain(BOT_PACKET_EXCLUDED_COPY);
  });

  it('answers the unknown-pin case as a note, not a crash', () => {
    const copy = botPacketVerdictCopy(
      { ...GOOD_PACKET, modelPin: 'nonsense/model' },
      { model: 'unknown' },
    );
    expect(copy).toContain('does not serve');
    expect(copy).toContain('Nothing is applied');
  });

  it('answers the absent-pin case as gateway-default', () => {
    const copy = botPacketVerdictCopy({ ...GOOD_PACKET, modelPin: undefined }, { model: 'absent' });
    expect(copy).toContain('gateway default');
  });
});
