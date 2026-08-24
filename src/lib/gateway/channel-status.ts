/**
 * Pure model for the dashboard's persistent channel-status row (Tier 2.6).
 * Channels — the operator's live bridges (Discord, Telegram, ...) — used to
 * surface only when something broke, via the degraded-only Channel Repair
 * card. This row keeps them visible on every dashboard render where the
 * connected gateway's snapshot says anything at all about channels.
 *
 * Honesty boundary: the capability snapshot carries family-level truth only —
 * whether the channels family is offered and healthy as a whole. It never
 * counts individual bridges; the group's available/total figures tally slash
 * commands, so this model deliberately does not repeat them.
 */

import type { GatewayCapabilityGroup } from '@/lib/gateway/types';

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

  switch (status) {
    case 'ready':
    case 'available':
      return { visible: true, tone: 'live', label, detail: 'Ready - manage from chat' };
    case 'partial':
      return {
        visible: true,
        tone: 'attention',
        label,
        detail: 'Some channels degraded - open chat to repair',
      };
    case 'unhealthy':
      return {
        visible: true,
        tone: 'attention',
        label,
        detail: 'Channels degraded - open chat to repair',
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
      return { visible: true, tone: 'quiet', label, detail: 'Not confirmed yet' };
  }
}
