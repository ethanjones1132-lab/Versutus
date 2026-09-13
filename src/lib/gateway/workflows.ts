// ─── Workflows: this device's store ───────────────────────────────────────
// The pure definition and folds live in `workflow-model.ts`; this module adds
// the per-gateway key-value persistence. No gateway route carries a workflow,
// so — like P3's session labels and D5's budgets — a workflow is THIS
// device's, and the store is best-effort.

import { keyValueStorage } from '@/lib/storage/key-value';
import { workflowsFromUnknown, type Workflow } from '@/lib/gateway/workflow-model';

export * from '@/lib/gateway/workflow-model';

/** What a workflow is stored under, per gateway. */
export const WORKFLOWS_STORAGE_PREFIX = 'versutus:workflows:';

export function workflowsStorageKey(gatewayId: string): string {
  return `${WORKFLOWS_STORAGE_PREFIX}${gatewayId}`;
}

/** Read this gateway's workflows. A refused or unreadable store is none. */
export async function loadWorkflows(gatewayId: string): Promise<Workflow[]> {
  try {
    const raw = await keyValueStorage.getItem(workflowsStorageKey(gatewayId));
    if (!raw) return [];
    return workflowsFromUnknown(JSON.parse(raw) as unknown);
  } catch {
    return [];
  }
}

/** Write this gateway's workflows back. Best-effort. */
export async function saveWorkflows(gatewayId: string, workflows: Workflow[]): Promise<void> {
  try {
    await keyValueStorage.setItem(workflowsStorageKey(gatewayId), JSON.stringify(workflows));
  } catch {
    // best-effort: a workflow must never break the surface that set it
  }
}
