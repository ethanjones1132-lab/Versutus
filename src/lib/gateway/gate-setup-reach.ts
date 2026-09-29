import type { GatewayKind } from './types';

/**
 * Whether Gate setup's Gate-only tabs (providers, CLI environments,
 * capabilities, push) can be served by the connection the phone holds.
 *
 * Those tabs speak the Gate's RPCs. A plain Hermes API server answers none of
 * them, so drawing the tabs there only produced a stack of "not supported by
 * this gateway" cards over empty claims. A Gate connected before its manifest
 * answered is still a Gate — the provider rebuilds its client the moment the
 * manifest lands (src/lib/portal/attach-manifest.ts) — so it waits rather
 * than being told it is not one.
 */
export type GateSetupReach = 'gate' | 'reaching-gate' | 'not-a-gate' | 'disconnected';

export function gateSetupReach({
  status,
  kind,
  hasManifest,
}: {
  status: string;
  kind: GatewayKind | undefined;
  hasManifest: boolean;
}): GateSetupReach {
  if (status !== 'connected') return 'disconnected';
  if (hasManifest) return 'gate';
  if (kind === 'custom') return 'reaching-gate';
  return 'not-a-gate';
}
