import {
  channelBridgeVerdict,
  channelGroupHealth,
} from '@/lib/gateway/channel-status';
import { buildCapabilitySnapshot } from '@/lib/gateway/dashboard';
import type { GatewayCapabilities } from '@/lib/gateway/types';
import type { GatewayCapabilityInstance } from '@/lib/portal/manifest';

/**
 * A declaring gateway describes each channel bridge in its manifest entry;
 * these pins are the copy decision Rook's LOW (2026-08-24T15:30) asked for:
 * the snapshot must be able to say partial/unhealthy from real per-bridge
 * truth instead of leaving those states unreachable.
 */
function bridge(id: string, manifestEntry?: Record<string, unknown>): GatewayCapabilityInstance {
  const instance: GatewayCapabilityInstance = {
    id,
    kind: 'channel',
    label: id,
    family: 'channels',
  };
  if (manifestEntry !== undefined) instance.manifestEntry = manifestEntry;
  return instance;
}

describe('channelBridgeVerdict', () => {
  test('a boolean healthy switch wins over any state word', () => {
    expect(channelBridgeVerdict(bridge('a', { healthy: true, state: 'down' }))).toBe('healthy');
    expect(channelBridgeVerdict(bridge('a', { healthy: false, state: 'ok' }))).toBe('down');
  });

  test('the state vocabulary buckets exactly, case-insensitively', () => {
    for (const state of ['ok', 'READY', ' Connected ', 'healthy']) {
      expect(channelBridgeVerdict(bridge('a', { state }))).toBe('healthy');
    }
    for (const state of ['degraded', 'Partial', 'reconnecting']) {
      expect(channelBridgeVerdict(bridge('a', { state }))).toBe('degraded');
    }
    for (const state of ['down', 'error', 'FAILED', 'disconnected', 'stopped']) {
      expect(channelBridgeVerdict(bridge('a', { state }))).toBe('down');
    }
  });

  test('anything unconfirmed stays unverified — never folded into healthy or broken', () => {
    expect(channelBridgeVerdict(bridge('a'))).toBe('unverified');
    expect(channelBridgeVerdict(bridge('a', {}))).toBe('unverified');
    expect(channelBridgeVerdict(bridge('a', { state: 'vibing' }))).toBe('unverified');
    expect(channelBridgeVerdict(bridge('a', { state: 42 }))).toBe('unverified');
    expect(channelBridgeVerdict(bridge('a', { healthy: 'yes' }))).toBe('unverified');
  });
});

describe('channelGroupHealth', () => {
  test('no declared bridges means no verdict — the caller keeps undeclared', () => {
    expect(channelGroupHealth([])).toBeNull();
  });

  test('every bridge confirmed healthy reads ready with no qualification', () => {
    const health = channelGroupHealth([bridge('d1', { state: 'ok' }), bridge('d2', { healthy: true })]);
    expect(health).toEqual({ status: 'ready' });
  });

  test('some confirmed-broken alongside healthy ones is partial, with the tally', () => {
    const health = channelGroupHealth([
      bridge('d1', { state: 'ok' }),
      bridge('d2', { state: 'degraded' }),
      bridge('d3', { healthy: false }),
    ]);
    expect(health?.status).toBe('partial');
    expect(health?.note).toBe('1 of 3 channel bridges healthy');
  });

  test('zero healthy bridges with any confirmed trouble is unhealthy', () => {
    const health = channelGroupHealth([bridge('d1', { state: 'down' })]);
    expect(health?.status).toBe('unhealthy');
    expect(health?.note).toBe('0 of 1 channel bridges healthy');
  });

  test('declared-but-unconfirmed fleets stay unknown instead of pretending', () => {
    const allUnverified = channelGroupHealth([bridge('d1'), bridge('d2')]);
    expect(allUnverified?.status).toBe('unknown');
    expect(allUnverified?.note).toBe('2 declared - bridge states not confirmed');

    const partlyConfirmed = channelGroupHealth([bridge('d1', { state: 'ok' }), bridge('d2')]);
    expect(partlyConfirmed?.status).toBe('unknown');

    // Unverified bridges do not soften confirmed breakage either.
    const brokenWithUnknowns = channelGroupHealth([
      bridge('d1', { state: 'disconnected' }),
      bridge('d2'),
      bridge('d3'),
    ]);
    expect(brokenWithUnknowns?.status).toBe('unhealthy');
  });
});

const CAPS = {
  object: 'gate.capabilities',
  platform: 'gate',
  model: 'gate',
  auth: { type: 'bearer', required: true },
  runtime: { mode: 'rpc', tool_execution: 'native', split_runtime: false, description: '' },
  features: {},
  endpoints: {},
} as unknown as GatewayCapabilities;

function channelsGroup(instances: GatewayCapabilityInstance[]) {
  const snapshot = buildCapabilitySnapshot('connected', null, undefined, Date.now(), CAPS, instances);
  const group = snapshot.groups.find((entry) => entry.id === 'channels');
  if (!group) throw new Error('No capability group "channels"');
  return group;
}

describe('buildCapabilitySnapshot drives the channels group from bridge truth', () => {
  test('a healthy declared fleet is ready — same verdict the bare instance used to get', () => {
    const group = channelsGroup([bridge('discord', { state: 'ok' }), bridge('telegram', { healthy: true })]);
    expect(group.status).toBe('ready');
  });

  test('mixed fleet goes partial with the tally, so attention states are reachable', () => {
    const group = channelsGroup([bridge('discord', { state: 'ok' }), bridge('telegram', { state: 'down' })]);
    expect(group.status).toBe('partial');
    expect(group.note).toBe('1 of 2 channel bridges healthy');
  });

  test('an all-down fleet goes unhealthy, driving the row attention verdict', () => {
    const group = channelsGroup([bridge('discord', { healthy: false }), bridge('telegram', { state: 'error' })]);
    expect(group.status).toBe('unhealthy');
  });

  test('a declared but unconfirmed fleet reads unknown, not ready', () => {
    const group = channelsGroup([bridge('discord'), bridge('telegram', {})]);
    expect(group.status).toBe('unknown');
    expect(group.note).toBe('2 declared - bridge states not confirmed');
  });

  test('no channel declarations keeps the old undeclared path (row hidden)', () => {
    const group = channelsGroup([]);
    expect(group.status).toBe('undeclared');
  });

  test('non-channel declarations do not wake the channels branch', () => {
    const group = channelsGroup([
      { id: 'my-openai', kind: 'provider', label: 'OpenAI Production', family: 'models' },
    ]);
    expect(group.status).toBe('undeclared');
  });

  test('a disconnected gateway still reports unavailable even with healthy bridges', () => {
    const snapshot = buildCapabilitySnapshot('disconnected', null, undefined, Date.now(), CAPS, [
      bridge('discord', { state: 'ok' }),
    ]);
    const group = snapshot.groups.find((entry) => entry.id === 'channels');
    expect(group?.status).toBe('unavailable');
  });
});
