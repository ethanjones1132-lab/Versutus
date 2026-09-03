import type { GatewayBackend } from '@/lib/portal/manifest';

function clean(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * The chip label for a chat backend on the Gate setup screen. The Gate's
 * `backendManager.describe()` already reports each backend's liveness
 * (`state`) plus its CLI version, carried on the held manifest — the setup
 * screen rendered bare labels, so a stopped backend looked identical to a
 * ready one until a send failed. A backend with no reported state keeps
 * today's label-only chip, never a guessed state.
 */
export function backendChipLabel(backend: GatewayBackend): string {
  const state = clean(backend.state);
  if (!state) return backend.label;
  const version = clean(backend.cliVersion);
  return version ? `${backend.label} · ${state} · ${version}` : `${backend.label} · ${state}`;
}

/**
 * Whether the chip carries freshness beyond the bare label. False when the
 * Gate reported no state — the caller keeps the label-only chip.
 */
export function backendChipHasFreshness(backend: GatewayBackend): boolean {
  return clean(backend.state) !== undefined;
}
