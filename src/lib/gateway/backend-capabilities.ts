import type { GatewayBackend } from '@/lib/portal/manifest';

export type BackendCapabilities = {
  sessions: boolean;
  tools: boolean;
  /** Agentic runs — a run id, streamed events and a terminal state. */
  runs: boolean;
};

/**
 * The manifest advertises the union across every backend — true for the Gate,
 * misleading once one backend is in use. A conversation runs inside exactly one
 * backend, so its capabilities are the ones that matter.
 *
 * An unknown selection falls back to the union rather than reporting nothing:
 * a backend removed on the Gate must not make the app claim less than it can do.
 */
export function capabilitiesForBackend(
  backends: GatewayBackend[],
  selectedBackendId: string | undefined,
): BackendCapabilities {
  const selected = selectedBackendId
    ? backends.find((backend) => backend.id === selectedBackendId)
    : undefined;
  const source = selected ? [selected] : backends;
  const can = (capability: string) =>
    source.some((backend) => (backend.capabilities ?? []).includes(capability));
  return { sessions: can('sessions'), tools: can('tools'), runs: can('runs') };
}
