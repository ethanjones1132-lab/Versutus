/**
 * Pure model for the dashboard's persistent channel-status row (Tier 2.6).
 * Channels — the operator's live bridges (Discord, Telegram, ...) — used to
 * surface only when something broke, via the degraded-only Channel Repair
 * card. This row keeps them visible on every dashboard render where the
 * connected gateway's snapshot says anything at all about channels.
 *
 * Honesty boundary: the capability snapshot carries family-level truth only —
 * whether the channels family is offered and healthy as a whole. The group's
 * available/total figures tally slash commands, so this model deliberately
 * does not repeat them; a per-bridge note from the snapshot (when one exists)
 * may surface as richer detail for an attention state, and that note tallies
 * bridges — never commands.
 */

import type { GatewayCapabilityGroup } from '@/lib/gateway/types';
import type { GatewayCapabilityInstance } from '@/lib/portal/manifest';

export type ChannelStatusTone = 'live' | 'attention' | 'quiet';

export type ChannelStatusRowModel = {
  /** False when no gateway kind defines channels at all — nothing to report. */
  visible: boolean;
  tone: ChannelStatusTone;
  label: string;
  detail: string;
};

export function describeChannelStatusRow(
  group?: GatewayCapabilityGroup,
): ChannelStatusRowModel {
  const status = group?.status;
  const label = group?.label || 'Channels';
  if (!group || status === 'undeclared') {
    return { visible: false, tone: 'quiet', label, detail: '' };
  }

  // A bridge-level note from the snapshot is more specific truth than the
  // static per-status copy ("2 of 3 channel bridges healthy" beats "Some
  // channels degraded"), so it wins wherever the health helper wrote one.
  // It tallies bridges, never slash commands — that honesty boundary holds.
  const detail = (fallback: string) => (group.note ? group.note : fallback);

  switch (status) {
    case 'ready':
    case 'available':
      return { visible: true, tone: 'live', label, detail: 'Ready - manage from chat' };
    case 'partial':
      return {
        visible: true,
        tone: 'attention',
        label,
        detail: detail('Some channels degraded - open chat to repair'),
      };
    case 'unhealthy':
      return {
        visible: true,
        tone: 'attention',
        label,
        detail: detail('Channels degraded - open chat to repair'),
      };
    case 'missing-scope':
      return { visible: true, tone: 'quiet', label, detail: 'No permission to check channels' };
    case 'unsupported':
      return { visible: true, tone: 'quiet', label, detail: 'This gateway offers no channels' };
    case 'warming':
      return { visible: true, tone: 'quiet', label, detail: 'Warming up - not confirmed yet' };
    case 'stale':
      return { visible: true, tone: 'quiet', label, detail: 'Last check is stale' };
    case 'unavailable':
      return { visible: true, tone: 'quiet', label, detail: 'Gateway offline' };
    case 'experimental':
      return { visible: true, tone: 'quiet', label, detail: 'Experimental support' };
    default:
      // `unknown` and any future status: the snapshot has no verdict yet.
      return { visible: true, tone: 'quiet', label, detail: detail('Not confirmed yet') };
  }
}

// ─── Channel-bridge health (the snapshot's channels-group verdict) ──────────

export type ChannelBridgeVerdict = 'healthy' | 'degraded' | 'down' | 'unverified';

/**
 * What one manifest-declared bridge says about itself.
 *
 * A declaring gateway describes each channel instance in its `manifestEntry`.
 * Two shapes are read, in this order of authority:
 *   - `healthy: boolean` — the blunt switch;
 *   - `state: string`    — a word from the vocabulary below (case-insensitive).
 * Anything else — missing entry, unknown word — is `unverified`, which is
 * never folded into healthy or broken. An unverified bridge means "not
 * confirmed", and claiming either way would be fiction.
 */
const HEALTHY_STATES = new Set(['ok', 'ready', 'connected', 'healthy']);
const DEGRADED_STATES = new Set(['degraded', 'partial', 'reconnecting']);
const DOWN_STATES = new Set(['down', 'error', 'failed', 'disconnected', 'stopped']);

export function channelBridgeVerdict(instance: GatewayCapabilityInstance): ChannelBridgeVerdict {
  const entry = instance.manifestEntry;
  if (!entry) return 'unverified';
  if (typeof entry.healthy === 'boolean') return entry.healthy ? 'healthy' : 'down';
  const state = typeof entry.state === 'string' ? entry.state.trim().toLowerCase() : '';
  if (HEALTHY_STATES.has(state)) return 'healthy';
  if (DEGRADED_STATES.has(state)) return 'degraded';
  if (DOWN_STATES.has(state)) return 'down';
  return 'unverified';
}

export type ChannelGroupHealth = {
  status: 'ready' | 'partial' | 'unhealthy' | 'unknown';
  note?: string;
};

/**
 * Aggregate per-bridge verdicts into the channels group's family status.
 *
 * This is the real channel-surface signal behind the row's attention tones
 * and the Channel Repair card: without it the group could only ever read
 * ready or undeclared, so both were unreachable code. The copy contract
 * matches describeChannelStatusRow's wording — `partial` means SOME bridges
 * degraded, `unhealthy` means the whole family reads degraded — and a
 * declared-but-unconfirmed fleet stays `unknown` rather than pretending.
 * Null means "no channels declared at all": the caller keeps its existing
 * undeclared path. No network calls; this reads only what the manifest
 * already carried.
 */
export function channelGroupHealth(
  instances: GatewayCapabilityInstance[],
): ChannelGroupHealth | null {
  const total = instances.length;
  if (total === 0) return null;

  let healthy = 0;
  let troubled = 0;
  for (const instance of instances) {
    const verdict = channelBridgeVerdict(instance);
    if (verdict === 'healthy') healthy += 1;
    else if (verdict === 'degraded' || verdict === 'down') troubled += 1;
  }

  if (troubled > 0 && healthy > 0) {
    return {
      status: 'partial',
      note: `${healthy} of ${total} channel bridges healthy`,
    };
  }
  if (troubled > 0) {
    return {
      status: 'unhealthy',
      note: `0 of ${total} channel bridges healthy`,
    };
  }
  if (healthy === total) return { status: 'ready' };
  return {
    status: 'unknown',
    note: `${total} declared - bridge states not confirmed`,
  };
}
