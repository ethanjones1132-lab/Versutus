import type { GatewayProfile } from '@/lib/gateway/types';

type ModelBearing = Pick<GatewayProfile, 'model' | 'backendModels' | 'botModels'>;

/** The fields a model catalog entry can be searched by. */
export type ModelSearchable = { id: string; provider?: string; providerId?: string };

/**
 * Narrow a model catalog by a free-text query over id and provider.
 *
 * Catalogs run to hundreds of entries on some providers, so grouping alone is
 * not enough to find a model by name.
 */
export function filterModels<T extends ModelSearchable>(models: T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  // Same reference when there is nothing to filter — no needless re-render.
  if (!needle) return models;
  return models.filter(
    (model) =>
      model.id.toLowerCase().includes(needle) ||
      model.provider?.toLowerCase().includes(needle) === true ||
      model.providerId?.toLowerCase().includes(needle) === true,
  );
}

/**
 * Narrow a catalog to the backend currently routing chat.
 *
 * A Gate's /v1/models flattens every backend's models into one list tagged
 * with backendId; offering them all lets a model tap silently switch backend.
 * Rows with no backendId (direct Hermes /api/model/options, the non-backend
 * branch of the Gate handler) belong to no backend and always stay visible.
 * With no backend selected there is nothing to scope to — return the catalog
 * unchanged, same reference, so memoised pickers do not re-render.
 */
export function scopeModelsToBackend<T extends { backendId?: string }>(
  models: T[],
  selectedBackendId: string | undefined,
): T[] {
  if (!selectedBackendId) return models;
  return models.filter((m) => !m.backendId || m.backendId === selectedBackendId);
}

/**
 * Whether two model ids name the same model under different qualification.
 *
 * The picker stores `providerId/modelId` (and Hermes `/api/model/options`
 * already puts a vendor prefix on the model id, so Nous Portal's Laguna
 * becomes `nous/poolside/laguna-xs-2.1:free`). The session and the turn
 * report often drop the outer provider. A raw string compare then claims a
 * swap that never happened.
 *
 * True when the trimmed ids match case-insensitively, or one is the other
 * with extra `provider/` prefixes. Missing either side is not a match —
 * callers that want "unknown" treat empty as a separate case.
 */
export function sameModelId(a?: string | null, b?: string | null): boolean {
  const left = a?.trim().toLowerCase();
  const right = b?.trim().toLowerCase();
  if (!left || !right) return false;
  if (left === right) return true;
  return left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
}

/**
 * Label for a picker row that already sits under a provider section.
 *
 * The send id is `providerId/modelId` and Hermes model ids often carry a
 * second vendor prefix (`nous/poolside/laguna-xs-2.1:free`). Rendering that
 * full slug on one line truncates before the part the operator needs to
 * tell models apart. Drop the section's provider and any remaining path,
 * leaving the model token — `laguna-xs-2.1:free`.
 */
export function modelPickerName(input: {
  id: string;
  modelId?: string;
  providerId?: string;
}): string {
  const raw = (input.modelId ?? input.id).trim();
  if (!raw) return input.id;
  let rest = raw;
  const provider = input.providerId?.trim();
  if (provider) {
    const prefix = `${provider}/`;
    if (rest.toLowerCase().startsWith(prefix.toLowerCase())) {
      rest = rest.slice(prefix.length);
    }
  }
  const slash = rest.lastIndexOf('/');
  if (slash !== -1) rest = rest.slice(slash + 1);
  return rest || input.id;
}

/** One provider entry from Hermes GET /api/model/options. */
export type HermesProviderCatalog = {
  slug?: string;
  id?: string;
  name?: string;
  models?: string[];
  authenticated?: boolean;
};

/** Body of Hermes GET /api/model/options. */
export type HermesModelOptions = {
  providers?: HermesProviderCatalog[] | Record<string, HermesProviderCatalog>;
};

/** One picker row flattened from Hermes /api/model/options. */
export type FlattenedCatalogModel = {
  id: string;
  providerId: string;
  modelId: string;
  provider?: string;
  available: boolean;
  label: string;
};

/**
 * Flatten Hermes `/api/model/options` into picker rows.
 *
 * `/v1/models` is a single `hermes-agent` entry — true to the OpenAI
 * contract, useless for picking. The real catalog is per-provider model
 * lists. Ids stay `providerId/modelId` so Gate `parseQualifiedModel` can
 * split the first slash into `{provider, model}` for the upstream call.
 *
 * `available` follows `authenticated`: an unsigned-in provider's rows
 * stay visible but not selectable, instead of pinning a session that
 * then completes with no assistant content.
 */
export function flattenHermesModelOptions(
  body: HermesModelOptions | null | undefined,
): FlattenedCatalogModel[] {
  if (!body?.providers) return [];
  const providers = Array.isArray(body.providers)
    ? body.providers
    : Object.values(body.providers);
  const models: FlattenedCatalogModel[] = [];
  for (const provider of providers) {
    const providerId = provider.slug ?? provider.id ?? provider.name;
    if (!providerId) continue;
    const available = provider.authenticated !== false;
    const display = provider.name ?? providerId;
    for (const modelId of provider.models ?? []) {
      if (!modelId) continue;
      models.push({
        id: `${providerId}/${modelId}`,
        providerId,
        modelId,
        provider: display,
        available,
        label: `${display} · ${modelId}`,
      });
    }
  }
  return models;
}

/** The model a send should use: Bot pick, else backend memory, else profile. */
export function effectiveModel(
  gateway: ModelBearing | null | undefined,
  selectedBackendId: string | undefined,
  selectedBotId?: string,
): string | undefined {
  if (!gateway) return undefined;
  // A Bot answers as itself. Its model belongs to its Hermes profile — anvil
  // is grok-4.6, ledger is a deepseek on nvidia — so the ONLY thing that may
  // override it is an explicit per-Bot pick. Falling through to the
  // configurable-chat model here would hand every Bot whatever the last
  // untargeted thread happened to use; harmless while Hermes ignored the
  // per-turn model on an open session, and a silent identity swap the moment
  // sessions began being pinned at creation.
  if (selectedBotId) return gateway.botModels?.[selectedBotId];
  if (selectedBackendId) {
    const remembered = gateway.backendModels?.[selectedBackendId];
    // A selected CLI environment owns its default. Falling through to the
    // configurable-chat model would pin a first turn to the wrong model.
    return remembered;
  }
  return gateway.model;
}

/**
 * Records a model choice.
 *
 * Without a Bot: writes `model` and `backendModels` so every send path that
 * still reads `gateway.model` stays correct.
 * With a Bot: writes **only** `botModels` so configurable chat is not stolen
 * (ADR 0014).
 */
export function withSelectedModel<T extends ModelBearing>(
  gateway: T,
  modelId: string,
  selectedBackendId: string | undefined,
  selectedBotId?: string,
): T {
  if (selectedBotId) {
    return {
      ...gateway,
      botModels: { ...(gateway.botModels ?? {}), [selectedBotId]: modelId },
    };
  }
  if (!selectedBackendId) return { ...gateway, model: modelId };
  return {
    ...gateway,
    model: modelId,
    backendModels: { ...(gateway.backendModels ?? {}), [selectedBackendId]: modelId },
  };
}

/** Send-time model payload. Prefer this over reading `gateway.model` directly. */
export function resolveSendModel(
  gateway: ModelBearing | null | undefined,
  selectedBackendId: string | undefined,
  selectedBotId: string | undefined,
): { model?: string } {
  const model = effectiveModel(gateway, selectedBackendId, selectedBotId);
  return model ? { model } : {};
}

/**
 * Re-validate a persisted model pin against a live catalog.
 *
 * The picker locks rows whose provider is not signed in, but that gate only
 * applies while the picker is open. A pin written while its provider was
 * signed in outlives the login: nothing re-reads the catalog on connect, so
 * the next send goes to the dead model and the backend completes the turn
 * with no assistant content.
 *
 * Returns the stale pin and the first available catalog entry to fall back
 * to, or null when the pin is still good — including when the catalog simply
 * does not list it. An absent match proves nothing (an older Hermes can
 * answer a partial catalog), so only an explicit `available: false` on the
 * matching row condemns a pin. Entries without the field at all predate the
 * signal and count as available.
 */
export function staleModelPin(
  catalog: readonly { id: string; available?: boolean; providerId?: string }[],
  pinnedModel: string | undefined,
  options: {
    /**
     * True when the catalogue lists EVERY provider its environment has — a
     * Bot's Hermes catalogue does (`/api/model/options` enumerates configured
     * providers). Only then does a missing provider condemn a pin; a partial
     * catalogue elsewhere still proves nothing.
     */
    providersAuthoritative?: boolean;
  } = {},
): { pinned: string; fallback?: string; reason: 'unavailable' | 'unknown-provider' } | null {
  const pinned = pinnedModel?.trim();
  if (!pinned) return null;
  const fallbackFor = () =>
    catalog.find((entry) => entry.available !== false && !sameModelId(entry.id, pinned))?.id;
  const match = catalog.find((entry) => sameModelId(entry.id, pinned));
  if (match) {
    return match.available === false ? { pinned, fallback: fallbackFor(), reason: 'unavailable' } : null;
  }
  // Absence alone condemns nothing: an older Hermes can answer a partial
  // catalogue. But a pin naming a PROVIDER this catalogue does not have at all
  // cannot run here. On 2026-09-16 a Bot carried "opencode-go/omen-alpha" from
  // the Gate's provider list; its Hermes catalogue has no `opencode-go`, every
  // turn failed, and the pin survived because the model was merely unlisted.
  if (!options.providersAuthoritative) return null;
  const pinnedProvider = providerOf(pinned);
  if (!pinnedProvider) return null;
  const providers = new Set(
    catalog.map((entry) => entry.providerId ?? providerOf(entry.id)).filter((id): id is string => Boolean(id)),
  );
  if (providers.size === 0 || providers.has(pinnedProvider)) return null;
  return { pinned, fallback: fallbackFor(), reason: 'unknown-provider' };
}

/**
 * The system note a repaired (or unrepairable) pin leaves in the thread. The
 * two reasons need different words: an unknown provider is a pin this Bot can
 * never run, not a login that lapsed.
 */
export function stalePinNote(stale: {
  pinned: string;
  fallback?: string;
  reason: 'unavailable' | 'unknown-provider';
}): string {
  const why =
    stale.reason === 'unknown-provider'
      ? 'this Bot has no such provider'
      : 'its provider is not signed in on the host';
  if (!stale.fallback) {
    return stale.reason === 'unknown-provider'
      ? `Pinned model ${stale.pinned} cannot run — ${why}, and its catalogue has no other model to switch to. Pick another model.`
      : `Pinned model ${stale.pinned} cannot run — ${why}, and the catalog has no signed-in model to switch to. Sign in (run hermes model on the host) or pick another model.`;
  }
  return `Pinned model ${stale.pinned} cannot run — ${why}. Switched to ${stale.fallback}; a new session opens on the next send.`;
}

/**
 * The model a first connect may pin as a profile's default, or undefined.
 *
 * Only a provider-only Gate needs one: its chats have nowhere else to go. A
 * Gate that fronts backends routes chat through them (Hermes owns its models),
 * and pinning its first PROVIDER model sent every turn that had lost its Bot to
 * that provider instead of Hermes (2026-09-16).
 */
export function connectDefaultModel(
  profile: { model?: string },
  manifest: { backends?: readonly unknown[] },
  providers: readonly { models?: readonly string[] }[],
): string | undefined {
  if (profile.model) return undefined;
  if ((manifest.backends?.length ?? 0) > 0) return undefined;
  const first = providers[0]?.models?.[0];
  return typeof first === 'string' && first.length > 0 ? first : undefined;
}

/** The provider segment of a qualified "provider/model" id, if it has one. */
function providerOf(id: string): string | undefined {
  const separator = id.indexOf('/');
  return separator > 0 ? id.slice(0, separator) : undefined;
}

/** One collapsible provider group in the picker's section list. */
export type ModelSection<T extends ModelSearchable = ModelSearchable> = {
  key: string;
  title: string;
  data: T[];
};

/** Group key (and section key) for models reporting no provider identity. */
export const OTHER_GROUP_KEY = 'other';

/**
 * Group a flat catalog into per-provider sections for the model picker.
 *
 * A gateway catalog runs to hundreds of entries once several providers are
 * registered, so the picker renders collapsible provider sections instead of
 * one flat list. `providerId` is the stable group key and `provider` is its
 * display name; models reporting neither land in one explicit "Other" group,
 * because dropping unattributed entries would hide real, selectable models.
 */
export function groupByProvider<T extends ModelSearchable>(models: T[]): ModelSection<T>[] {
  const groups = new Map<string, ModelSection<T>>();
  for (const model of models) {
    const key = model.providerId ?? model.provider ?? OTHER_GROUP_KEY;
    const title = model.provider ?? model.providerId ?? 'Other';
    const existing = groups.get(key);
    if (existing) {
      existing.data.push(model);
    } else {
      groups.set(key, { key, title, data: [model] });
    }
  }
  return [...groups.values()].sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * Whether picking a model must release the current thread's session.
 *
 * A Hermes session's model is fixed when the session is created —
 * `PATCH /api/sessions/{id}` refuses `model` outright — so a pick made
 * mid-thread can never take effect on that thread: every later turn answers on
 * whatever the session was opened with, while the picker goes on showing the
 * choice. Releasing the session is what makes the picker mean something; the
 * next send opens a fresh one pinned to it. This is the same trade the backend
 * switcher already makes, for the same reason.
 *
 * False whenever there is nothing to gain: no session open, or the same model
 * re-picked (compared on qualification-insensitive identity, so `openai/gpt-5`
 * and `gpt-5` are not a change worth resetting a conversation for).
 *
 * A first pick on a thread that never had an override DOES release, reversing
 * the earlier rule. That rule assumed an unpinned thread is "already running
 * the gateway's default", so a first pick would match what was already
 * serving and resetting would cost context for nothing. The assumption does
 * not hold: `effectiveModel` returns undefined whenever no override is stored,
 * and the app then has no idea what the host actually opened the session with.
 * Reported from device use on 2026-09-07 — the operator picked a model, the
 * session went on answering as something else, and the turn came back empty.
 * A pick that silently cannot take effect is worse than losing the transcript
 * of a no-op pick, so an unknown previous is now treated as "not proven to be
 * `next`" and the session is released.
 */
export function shouldReleaseSessionForModel(input: {
  previous?: string;
  next: string;
  hasSession: boolean;
}): boolean {
  if (!input.hasSession) return false;
  const next = input.next?.trim();
  if (!next) return false;
  const previous = input.previous?.trim();
  // Nothing to compare against: the app cannot prove the open session is
  // already serving `next`, so it must not assume that it is.
  if (!previous) return true;
  // Same comparison `canServeModel` uses. A raw string compare reports a
  // mismatch between two names for the same model and throws away a thread
  // that was already answering on the right one.
  return !sameModelId(previous, next);
}

/** System line for a transcript emptied because the session had to be released. */
export function modelSwitchAnnouncement(input: { previous: string; next: string }): string {
  return `New session opened. Was ${input.previous}, now ${input.next}.`;
}

/**
 * Apply a model pick the way the picker and `/model set` both must.
 *
 * Writes the Bot pin when a Bot is selected (ADR 0014) and says whether
 * the open session has to be released so the next turn actually runs on
 * `modelId`. A Hermes session's model is fixed at creation.
 */
export function applyModelOverride<T extends ModelBearing>(input: {
  gateway: T;
  modelId: string;
  selectedBackendId: string | undefined;
  selectedBotId?: string;
  hasSession: boolean;
}): { gateway: T; releaseSession: boolean } {
  return {
    gateway: withSelectedModel(
      input.gateway,
      input.modelId,
      input.selectedBackendId,
      input.selectedBotId,
    ),
    releaseSession: shouldReleaseSessionForModel({
      previous: effectiveModel(input.gateway, input.selectedBackendId, input.selectedBotId),
      next: input.modelId,
      hasSession: input.hasSession,
    }),
  };
}
