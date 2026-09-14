import {
  BOT_PACKET_EXCLUDED_COPY,
  BOT_PACKET_KIND,
  BOT_PACKET_VERSION,
  botPacketFileName,
  botPacketManifest,
  buildBotPacket,
  type BotPacket,
} from '@/lib/gateway/bot-packet';
import { EMPTY_BOT_SOUL } from '@/lib/gateway/bots';

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(...parts: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

const BOT = {
  id: 'scout',
  displayName: 'Scout',
  routable: true,
  description: 'Scouts the wire.',
  model: { default: 'glm-5.3-flash', provider: 'opencode-go' },
};

describe('Bot handoff packet', () => {
  test('a full Bot folds into a versioned packet carrying soul, description, and model pin', () => {
    const packet = buildBotPacket(BOT, { soul: 'Be curious.', loaded: true, failed: false });
    expect(packet.version).toBe(1);
    expect(packet.kind).toBe('versutus-bot-packet');
    expect(packet.bot).toEqual({ name: 'Scout', description: 'Scouts the wire.' });
    expect(packet.soul).toBe('Be curious.');
    expect(packet.modelPin).toBe('glm-5.3-flash');
  });

  test('the packet carries its trust block — the exclusions are IN the file', () => {
    const packet = buildBotPacket(BOT, undefined);
    expect(packet.trust.fields).toEqual(['soul', 'description', 'model pin']);
    expect(packet.trust.excluded).toEqual(['memory', 'credentials']);
  });

  test('a failed soul read is not folded in as silence — the packet omits it', () => {
    // "No standing instructions" is a fact about the Bot; a failed read is a
    // fact about the read. Only the first may travel as an absent soul.
    const packet = buildBotPacket(BOT, { soul: null, loaded: false, failed: true });
    expect('soul' in packet).toBe(false);
  });

  test('a soul the read says is genuinely empty is omitted too', () => {
    const packet = buildBotPacket(BOT, { soul: null, loaded: true, failed: false });
    expect('soul' in packet).toBe(false);
  });

  test('an unpinned Bot or one the Gate reports no pin for carries no model pin', () => {
    expect('modelPin' in buildBotPacket({ ...BOT, model: null }, undefined)).toBe(false);
    expect('modelPin' in buildBotPacket({ ...BOT, model: undefined }, undefined)).toBe(false);
  });

  test('a Bot with no description carries none, and one is never invented', () => {
    expect('description' in buildBotPacket({ ...BOT, description: null }, undefined)).toBe(false);
    expect(
      'description' in buildBotPacket({ ...BOT, description: undefined }, undefined),
    ).toBe(false);
  });

  test('a Bot with nothing but a name still builds a packet — the trust block is unconditional', () => {
    const packet = buildBotPacket(
      { displayName: 'bare', description: null, model: null },
      EMPTY_BOT_SOUL,
    );
    expect(packet.bot).toEqual({ name: 'bare' });
    expect(packet.trust.excluded).toEqual(['memory', 'credentials']);
    expect(packet.kind).toBe(BOT_PACKET_KIND);
  });

  test('the file name is stable, filesystem-safe, and versioned', () => {
    expect(botPacketFileName(BOT)).toBe('Scout-packet-v1.json');
    expect(botPacketFileName({ displayName: 'Scout / the: Second?' })).toBe(
      'Scout-the-Second-packet-v1.json',
    );
    // A name of only unsafe characters still yields a usable file name.
    expect(botPacketFileName({ displayName: '///' })).toBe('bot-packet-v1.json');
  });

  test('the manifest copy says what carries and what is excluded — the trust line is rendered', () => {
    const packet: BotPacket = buildBotPacket(BOT, {
      soul: 'Be curious.',
      loaded: true,
      failed: false,
    });
    const line = botPacketManifest(packet);
    expect(line).toContain('Carries: soul, description, model pin.');
    expect(line).toContain('Excluded by default: memory, credentials.');
    expect(line).toContain(BOT_PACKET_EXCLUDED_COPY);
  });

  test('the packet is JSON-serializable as the spec asks for a portable file', () => {
    const packet = buildBotPacket(BOT, { soul: 'Be curious.', loaded: true, failed: false });
    const round = JSON.parse(JSON.stringify(packet)) as BotPacket;
    expect(round).toEqual(packet);
    expect(round.version).toBe(BOT_PACKET_VERSION);
  });

  test('the pure module stays pure — no platform seam imports live here', () => {
    const src = readSource('src', 'lib', 'gateway', 'bot-packet.ts');
    expect(src).not.toContain('expo-sharing');
    expect(src).not.toContain('expo-file-system');
    expect(src).not.toContain('gatewayRequest');
    // The trust copy exists here, so the name it is pinned by exists in one place.
    expect(src).toContain('Memory and credentials are excluded by default.');
  });
});
