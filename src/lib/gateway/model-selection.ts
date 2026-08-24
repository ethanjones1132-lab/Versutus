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
  if (selectedBotId) {
    const botRemembered = gateway.botModels?.[selectedBotId];
    if (botRemembered) return botRemembered;
  }
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
