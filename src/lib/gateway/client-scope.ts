// ─── Which environment and Bot a freshly built client speaks for ─────
//
// `attachClient` builds a brand-new client on every re-attach: a reconnect, a
// Retry, an app resume, a gateway switch, and the late-manifest upgrade. The
// scope a client carries is its own (`setBackendId` / `setBotId`), so every one
// of those rebuilds started with none — while `selectedBackendId` /
// `selectedBotId` live in provider state and survived, so the UI went on
// showing the Hermes thread and the turn went out naming the Gate's own
// providers (`providerId: 'kilo'` on a Gate with no kilo provider).
//
// So a re-attach has to hand the scope over, and the one thing it must not do
// is hand gateway A's environment to gateway B's client. The decision is pure
// and lives here; the provider owns the refs.

/** The parts of a gateway profile that decide which Gate it belongs to. */
export type ScopedGateway = { id: string; parentId?: string } | null | undefined;

/**
 * Which Gate a profile belongs to: the parent when there is one.
 *
 * The same normalisation `saveCachedGateManifest` uses — a child profile serves
 * its parent's manifest, so it shares the parent's Gate, its backends and its
 * Bots.
 */
export function gatewayScopeKey(gateway: ScopedGateway): string | undefined {
  if (!gateway?.id) return undefined;
  return gateway.parentId ?? gateway.id;
}

export type ClientAttachScope = {
  /** The environment this client speaks for, or undefined to leave it unpinned. */
  backendId: string | undefined;
  /** The Bot this client is a thread for, or undefined for none. */
  botId: string | undefined;
  /** Whether the remembered scope belongs to another Gate and must be dropped. */
  reset: boolean;
};

/**
 * What a client being installed should be scoped to.
 *
 * Same Gate: the scope as it stands — a re-attach must not change which
 * conversation the operator is looking at, and that is the whole point of
 * carrying it over.
 *
 * Different Gate: nothing. A remembered environment and Bot are the names of
 * another Gate's world (`hermes-local` is one Gate's environment, `scout` one
 * of its Bots), and the new Gate adopts its own default through the existing
 * first-adoption effect, which needs `selectedBackendId` to be undefined.
 *
 * A scope with no recorded owner is kept rather than dropped: this module's own
 * bookkeeping being incomplete is not evidence that the operator's thread
 * belongs somewhere else, and throwing a live thread away on that suspicion is
 * the worse failure.
 */
export function scopeForAttach(input: {
  /** Which Gate this attach is for. */
  attachingGatewayKey: string | undefined;
  /** Which Gate the remembered scope belongs to, when it is known. */
  scopeGatewayKey: string | undefined;
  selectedBackendId: string | undefined;
  selectedBotId: string | undefined;
}): ClientAttachScope {
  const { attachingGatewayKey, scopeGatewayKey, selectedBackendId, selectedBotId } = input;
  const hasScope = Boolean(selectedBackendId) || Boolean(selectedBotId);
  const foreign = Boolean(
    hasScope && attachingGatewayKey && scopeGatewayKey && attachingGatewayKey !== scopeGatewayKey,
  );
  if (foreign) return { backendId: undefined, botId: undefined, reset: true };
  return { backendId: selectedBackendId, botId: selectedBotId, reset: false };
}
