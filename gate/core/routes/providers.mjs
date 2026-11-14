import { sanitizeSnapshot } from '../providers/rpc.mjs';
import { healthScopeId } from '../model-health.mjs';

export async function handleProviderRoute({
  req,
  res,
  url,
  pathname,
  method,
  providerService,
  providerStore,
  state,
  backendManager,
  modelRouter,
  modelHealth,
  listProvidersOrEmpty,
  resolveConversationScope,
  curateModels,
}) {
  void req;

  if (pathname === '/v1/providers' && method === 'GET') {
    let snapshots;
    try {
      snapshots = await providerService.list();
    } catch (error) {
      // Not 200 with an empty array: that is how a transient read failure
      // made the whole roster vanish from the phone with nothing anywhere
      // saying a read had failed.
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: { message: error.message, code: error.code ?? 'provider_roster_unreadable' },
      }));
      return true;
    }
    res.writeHead(200);
    res.end(JSON.stringify({ providers: snapshots.map(sanitizeSnapshot) }));
    return true;
  }

  const providerMatch = pathname.match(/^\/v1\/providers\/([^/]+)$/);
  if (providerMatch && method === 'GET') {
    try {
      const snapshot = await providerService.get(decodeURIComponent(providerMatch[1]));
      res.writeHead(200);
      res.end(JSON.stringify(sanitizeSnapshot(snapshot)));
    } catch {
      res.writeHead(404);
      res.end(JSON.stringify({ error: { message: 'provider not found', code: 'provider_not_found' } }));
    }
    return true;
  }

  // /v1/models - provider-owned live or labeled LKG/bootstrap catalogs
  if (pathname === '/v1/models' && method === 'GET') {
    // A backend owns its own catalog (ADR-0003); asking for one by id
    // must return only that catalog, never the Gate's provider list.
    // A Bot names its environment the same way, so a Bot's model list is
    // that Bot's own catalogue. `bot=` used to be ignored here: a Bot's
    // picker was handed the Gate's provider catalogue, the operator pinned
    // a provider Hermes does not have, and every turn to that Bot failed
    // (2026-09-16).
    const requestedBackendId = url.searchParams.get('backendId');
    const requestedBotId = url.searchParams.get('bot') || undefined;
    // `?refresh=1` is the operator (or a caller that just fixed a provider)
    // saying they asked for it now. Everything else is answered from the
    // router's cache, which answers a stale copy immediately and refreshes
    // it behind the request -- see backend-model-route.mjs.
    const forceRefresh = url.searchParams.get('refresh') === '1';
    if (requestedBackendId || requestedBotId) {
      const scope = await resolveConversationScope(requestedBackendId, requestedBotId);
      if (!scope?.backend) return true;
      const { backend, environmentId } = scope;
      try {
        // Read through the router's cache: an environment under its own id,
        // a Bot under its own key and through its own profile-scoped backend
        // (`forBot` answers `/p/<bot>`), so a Bot's copy can never be another
        // Bot's list. A Bot picker is the operator's everyday path, and an
        // uncached Hermes catalogue costs ~4 s per open. The routing lookup
        // only walks the environment roster, so it never sees the Bot keys.
        const catalogueId = requestedBotId ? `${environmentId}@bot:${requestedBotId}` : requestedBackendId;
        const catalogues = await modelRouter.cataloguesFor(
          [requestedBotId ? { id: catalogueId, read: () => backend.listModels() } : { id: catalogueId }],
          { refresh: forceRefresh },
        );
        // No copy and no answer means the read failed or overran its
        // bound. That is the 502 this route answered with before the
        // catalogue was cached — not an empty list, which would tell the
        // picker this environment serves nothing and say nothing about
        // why.
        if (!catalogues.has(catalogueId)) {
          throw new Error(
            requestedBotId
              ? `Bot "${requestedBotId}" did not answer with a model list.`
              : `Environment "${requestedBackendId}" did not answer with a model list.`,
          );
        }
        const models = catalogues.get(catalogueId);
        res.writeHead(200);
        res.end(JSON.stringify({
          object: 'list',
          data: curateModels(models.map((model) => ({
            ...model,
            object: 'model',
            ...(requestedBackendId ? { backendId: requestedBackendId } : {}),
            ...(requestedBotId ? { bot: requestedBotId } : {}),
          })), { health: modelHealth, scopeId: healthScopeId(environmentId, requestedBotId) }),
        }));
      } catch (error) {
        // The streaming branch above may already have sent headers.
        if (res.headersSent) {
          res.end();
          return true;
        }
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message, code: 'backend_error' } }));
      }
      return true;
    }

    const snapshots = await listProvidersOrEmpty();
    const allModels = [];
    for (const snapshot of snapshots) {
      // A disabled provider is asked nothing and answers nothing, so
      // offering its models only sends the picker somewhere that refuses.
      if (snapshot.readiness?.state === 'disabled') continue;
      const models = snapshot.catalog?.models?.length
        ? snapshot.catalog.models.map((model) => model.id)
        : state.providers.find((provider) => provider.id === snapshot.id)?.config.models ?? [];
      for (const modelId of models) {
        allModels.push({
          id: modelId,
          provider: snapshot.id,
          providerId: snapshot.id,
          label: modelId,
          object: 'model',
          catalogSource: snapshot.catalog?.source,
        });
      }
    }
    if (allModels.length === 0) {
      for (const provider of state.providers) {
        for (const modelId of provider.config.models || []) {
          allModels.push({
            id: modelId,
            provider: provider.id,
            providerId: provider.id,
            label: modelId,
            object: 'model',
          });
        }
      }
    }
    // Every model a native environment can reach, alongside direct
    // providers. Cold startup can be slow for a CLI environment, so let
    // independent backends load together while preserving catalog order.
    // Every backend owns a model list, so none is skipped here; a backend
    // that will not start is remembered by the manager and costs one attempt
    // per backoff window rather than one 30s wait per request. The read
    // itself is the router's cached one, so the whole aggregate is answered
    // from whatever is already in hand — and an environment whose read
    // failed is left out of the map and so contributes no rows, exactly as
    // the per-descriptor try/catch this replaced did.
    const descriptors = await backendManager.list().catch(() => []);
    const catalogues = await modelRouter
      .cataloguesFor(descriptors, { refresh: forceRefresh })
      .catch(() => new Map());
    const backendModels = descriptors.map((descriptor) =>
      (catalogues.get(descriptor.id) ?? []).map((model) => ({
        ...model, object: 'model', backendId: descriptor.id,
      })));
    for (const models of backendModels) allModels.push(...models);

    // Curation runs on every response, not on every read: a model that
    // started failing is hidden the next time the catalogue is asked for,
    // however fresh the copy behind it is. The Gate's own provider rows go
    // through the same pass and are hidden only by what a model IS (they
    // carry no provider metadata to merge on and no sign-in flag), plus the
    // failing-turn verdict IF one exists for their key — the provider path
    // (`chatViaProviderService` / `proxyChat`) records none today, so a Gate
    // provider model is never hidden for having refused here.
    res.writeHead(200);
    res.end(JSON.stringify({
      object: 'list',
      data: curateModels(allModels, { health: modelHealth }),
    }));
    return true;
  }

  // /p/{provider}/v1/models - scoped provider models
  const scopedModelMatch = pathname.match(/^\/p\/([^\/]+)\/v1\/models$/);
  if (scopedModelMatch && method === 'GET') {
    const providerId = decodeURIComponent(scopedModelMatch[1]);
    // Both sources, exactly as `dispatchChat` resolves them: a provider
    // created through the Gate's own UI exists only in the v2 store
    // (`migrateLegacyProviders` copies legacy files INTO it and never writes
    // back), so a route reading the legacy registry alone 404'd a provider
    // whose `POST /p/<id>/v1/chat/completions` is served. The v2 record wins,
    // as it does there.
    const record = await providerStore.get(providerId);
    const legacy = state.providers.find((provider) => provider.id === providerId);

    if (!record && !legacy) {
      res.writeHead(404);
      res.end(JSON.stringify({
        error: 'Not Found',
        message: `Provider ${providerId} not found`,
      }));
      return true;
    }

    const models = record
      ? (record.state?.catalog?.models ?? []).map((model) => model.id).filter(Boolean)
      : legacy.config.models || [];
    const modelList = models.map((modelId) => ({
      id: modelId,
      provider: providerId,
      label: modelId,
      object: 'model',
    }));

    res.writeHead(200);
    res.end(JSON.stringify({
      object: 'list',
      data: modelList,
    }));
    return true;
  }

  return false;
}
