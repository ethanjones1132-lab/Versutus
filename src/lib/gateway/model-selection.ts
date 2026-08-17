import type { GatewayProfile } from '@/lib/gateway/types';

type ModelBearing = Pick<GatewayProfile, 'model' | 'backendModels'>;

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

/** The model a send should use: the active backend's memory, else the profile's. */
export function effectiveModel(
  gateway: ModelBearing | null | undefined,
  selectedBackendId: string | undefined,
): string | undefined {
  if (!gateway) return undefined;
  if (selectedBackendId) {
    const remembered = gateway.backendModels?.[selectedBackendId];
    if (remembered) return remembered;
  }
  return gateway.model;
}

/**
 * Records a model choice. `model` is written too, not just the per-backend
 * entry: every existing send path reads `gateway.model`, and leaving it stale
 * would send the previous backend's model id to the new one.
 */
export function withSelectedModel<T extends ModelBearing>(
  gateway: T,
  modelId: string,
  selectedBackendId: string | undefined,
): T {
  if (!selectedBackendId) return { ...gateway, model: modelId };
  return {
    ...gateway,
    model: modelId,
    backendModels: { ...(gateway.backendModels ?? {}), [selectedBackendId]: modelId },
  };
}
