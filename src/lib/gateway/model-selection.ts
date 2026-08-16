import type { GatewayProfile } from '@/lib/gateway/types';

type ModelBearing = Pick<GatewayProfile, 'model' | 'backendModels'>;

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
