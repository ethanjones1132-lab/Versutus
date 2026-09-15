// The apply arm of the read-back: what the decision fold answers when an
// operator asks a picked packet to actually become a Bot. Written against
// the item's own gates — the gateway must create Bots at all, and a model
// pin must MATCH the catalog (an unknown pin stays a read-back note, never
// a write).

import {
  BOT_PACKET_KIND,
  BOT_PACKET_VERSION,
  type BotPacket,
} from '../src/lib/gateway/bot-packet';
import {
  applyBotPacket,
  BOT_PACKET_APPLY_REFUSAL_COPY,
  type BotPacketApplyReason,
} from '../src/lib/gateway/bot-packet-import';

const PACKET: BotPacket = {
  version: BOT_PACKET_VERSION,
  kind: BOT_PACKET_KIND,
  bot: { name: 'Scout', description: 'a scout' },
  soul: 'Stay sharp.',
  modelPin: 'nous/laguna:free',
  trust: { fields: ['soul', 'description', 'model pin'], excluded: ['memory', 'credentials'] },
};

describe('applyBotPacket', () => {
  it('matched pin + management → the exact createBot input', () => {
    expect(applyBotPacket(PACKET, { model: 'matched' }, true)).toEqual({
      ok: true,
      input: {
        name: 'Scout',
        soul: 'Stay sharp.',
        description: 'a scout',
        modelId: 'nous/laguna:free',
      },
    });
  });

  it('absent pin still applies — the gateway default is named by the note, not a refusal', () => {
    const unpinned: BotPacket = { ...PACKET, modelPin: undefined };
    const { modelId, ...input } = PACKET_APPROVAL_INPUT;
    void modelId;
    expect(applyBotPacket(unpinned, { model: 'absent' }, true)).toEqual({
      ok: true,
      input: { name: 'Scout', soul: 'Stay sharp.', description: 'a scout' },
    });
  });

  it('unknown pin refuses — a model this gateway does not serve is never written', () => {
    expect(applyBotPacket(PACKET, { model: 'unknown' }, true)).toEqual({
      ok: false,
      reason: 'unknown-pin',
    });
  });

  it('no Bot management refuses — the gate that cannot create a Bot applies nothing', () => {
    expect(applyBotPacket(PACKET, { model: 'matched' }, false)).toEqual({
      ok: false,
      reason: 'no-management',
    });
  });

  it('optional fields absent from the packet stay absent from the input', () => {
    const bare: BotPacket = {
      version: BOT_PACKET_VERSION,
      kind: BOT_PACKET_KIND,
      bot: { name: 'Scout' },
      trust: { fields: ['name'], excluded: ['memory'] },
    };
    expect(applyBotPacket(bare, { model: 'absent' }, true)).toEqual({
      ok: true,
      input: { name: 'Scout' },
    });
  });
});

describe('BOT_PACKET_APPLY_REFUSAL_COPY', () => {
  it.each(['unknown-pin', 'no-management'] as BotPacketApplyReason[])(
    'every refusal reason has operator words',
    (reason) => {
      expect(BOT_PACKET_APPLY_REFUSAL_COPY[reason]).toBeTruthy();
    },
  );
});

const PACKET_APPROVAL_INPUT = {
  name: 'Scout',
  soul: 'Stay sharp.',
  description: 'a scout',
  modelId: 'nous/laguna:free',
};
