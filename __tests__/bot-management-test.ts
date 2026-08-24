import { hasBotManagement } from '@/lib/gateway/bots';
import { hasGroupRooms } from '@/lib/gateway/groups';
import { ManifestClient } from '@/lib/gateway/manifest-client';
import type { GatewayProfile } from '@/lib/gateway/types';
import type { GatewayIdentity } from '@/lib/portal/identify';

// The B17 honesty rule: whether a gateway can manage agents or host rooms is
// decided BEFORE the operator fills a sheet — never by refusing afterwards.
// Adapters that do not speak the dialect (plain Hermes HTTP, OpenClaw) omit
// the calls entirely; a manifest client answers through its declared
// endpoints via its up-front getters.

const PROFILE: GatewayProfile = {
  id: 'g1',
  name: 'Test gate',
  url: 'http://gate.test:8760',
  kind: 'custom',
  token: 'k',
  createdAt: 0,
};

const IDENTITY: GatewayIdentity = {
  kind: 'custom',
  kindLabel: 'Custom — versutus-gate',
  auth: { schemes: ['bearer'], requiresToken: true, grantPath: '/.well-known/gateway/access' },
  manifest: {
    manifest: 'versutus-gateway/v1',
    kind: 'versutus-gate',
    name: 'Test Gate',
    auth: { schemes: ['bearer'], grantPath: '/.well-known/gateway/access' },
    transport: { primary: 'http' },
    endpoints: { health: '/health', models: '/v1/models', chat: '/v1/chat/completions' },
    capabilities: { chat: true, models: true },
  },
  source: 'manifest',
  identifiedAt: 0,
};

function manifestClientWith(endpoints: Record<string, string>): ManifestClient {
  const identity: GatewayIdentity = {
    ...IDENTITY,
    manifest: { ...IDENTITY.manifest!, endpoints },
  };
  return new ManifestClient(PROFILE, identity, {});
}

describe('hasBotManagement', () => {
  test('no client means no management', () => {
    expect(hasBotManagement(undefined)).toBe(false);
    expect(hasBotManagement(null)).toBe(false);
  });

  test('adapters that never speak bots hide creation before any sheet opens', () => {
    // Hermes-shaped plain HTTP and the OpenClaw adapter expose no bot calls;
    // their surfaces must not offer "New Agent" at all.
    const chatOnlyClient = { streamChat: async () => '' };
    expect(hasBotManagement({})).toBe(false);
    expect(hasBotManagement(chatOnlyClient)).toBe(false);
  });

  test('a client that speaks bots offers management', () => {
    expect(hasBotManagement({ createBot: async () => ({}) })).toBe(true);
  });

  test('a manifest verdict of false wins over mere method presence', () => {
    // A manifest client always carries the createBot method; its own word
    // about the declared endpoints is what makes the row honest.
    expect(hasBotManagement({ createBot: async () => ({}), canManageBots: false })).toBe(false);
  });

  test('a manifest verdict of true stands on its own', () => {
    expect(hasBotManagement({ canManageBots: true })).toBe(true);
  });
});

describe('hasGroupRooms', () => {
  test('no client and dialect-less adapters host no rooms', () => {
    expect(hasGroupRooms(undefined)).toBe(false);
    expect(hasGroupRooms(null)).toBe(false);
    expect(hasGroupRooms({})).toBe(false);
  });

  test('a client that speaks rooms offers them', () => {
    expect(hasGroupRooms({ createGroup: async () => ({}) })).toBe(true);
  });

  test('a manifest verdict overrides method presence both ways', () => {
    expect(hasGroupRooms({ createGroup: async () => ({}), canManageGroups: false })).toBe(false);
    expect(hasGroupRooms({ canManageGroups: true })).toBe(true);
  });
});

describe('ManifestClient capability getters', () => {
  test('declared endpoints read as manageable before any call is made', () => {
    const client = manifestClientWith({
      health: '/health',
      models: '/v1/models',
      chat: '/v1/chat/completions',
      bots: '/v1/bots',
      botGroups: '/v1/bot-groups',
    });
    expect(client.canManageBots).toBe(true);
    expect(client.canManageGroups).toBe(true);
  });

  test('a document without bots or rooms refuses up front instead of mid-form', () => {
    const client = manifestClientWith({
      health: '/health',
      models: '/v1/models',
      chat: '/v1/chat/completions',
    });
    expect(client.canManageBots).toBe(false);
    expect(client.canManageGroups).toBe(false);
  });

  test('bots without rooms stays honest per capability', () => {
    const client = manifestClientWith({
      health: '/health',
      models: '/v1/models',
      chat: '/v1/chat/completions',
      bots: '/v1/bots',
    });
    expect(client.canManageBots).toBe(true);
    expect(client.canManageGroups).toBe(false);
  });
});
