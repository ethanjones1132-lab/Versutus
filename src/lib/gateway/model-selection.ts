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
 * False whenever there is nothing to gain: no session open, the same model
 * re-picked, or a first pick on a thread that never had an override (there the
 * session is already running the gateway's default, and resetting would cost
 * the operator their context for nothing).
 */
export function shouldReleaseSessionForModel(input: {
  previous?: string;
  next: string;
  hasSession: boolean;
}): boolean {
  if (!input.hasSession) return false;
  const previous = input.previous?.trim();
  const next = input.next?.trim();
  if (!previous || !next) return false;
  return previous.toLowerCase() !== next.toLowerCase();
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
