/**
 * Pure model for the Home tab's no-gateway state: which sections hang off
 * the empty-state hero, and what the setup action should say. Kept free of
 * react/react-native imports so node tests lock the visibility rules.
 */

import { isGatewayTokenRequiredMessage } from '@/lib/gateway/errors';

export type HomeEmptyStateModel = {
  /** Active device pairing — render the approve-on-PC panel. */
  showPairing: boolean;
  /** A connect attempt failed — render the troubleshooting collapsible. */
  showTroubleshooting: boolean;
  /** Discovery reported candidates — render the found-nearby note. */
  showDiscovered: boolean;
  /** First run or token-required — render the onboarding action. */
  showSetupAction: boolean;
  setupLabel: string;
};

export function describeHomeEmptyState(input: {
  status: string;
  connectionPhase: string;
  lastError?: string | null;
  deviceId?: string | null;
  tailscaleHost?: string | null;
  discoveredCount: number;
}): HomeEmptyStateModel {
  const { status, connectionPhase, lastError, deviceId, tailscaleHost, discoveredCount } = input;
  return {
    showPairing: status === 'pairing' && !!deviceId,
    showTroubleshooting: !!lastError && connectionPhase === 'failed',
    showDiscovered: discoveredCount > 0,
    showSetupAction: !tailscaleHost || isGatewayTokenRequiredMessage(lastError),
    setupLabel: tailscaleHost ? 'Update setup token' : 'Set up PC address',
  };
}
