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
    if (remembered) return remembered;
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
