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

/** Read this gateway's workflows for display. A refused or unreadable store is none. */
export async function loadWorkflows(gatewayId: string): Promise<Workflow[]> {
  try {
    const raw = await keyValueStorage.getItem(workflowsStorageKey(gatewayId));
    if (!raw) return [];
    return workflowsFromUnknown(JSON.parse(raw) as unknown);
  } catch {
    return [];
  }
}

export type WorkflowStoreRead =
  | { ok: true; workflows: Workflow[] }
  | { ok: false; error: string };

/**
 * Read this gateway's workflows before a write that saves the list back. Unlike
 * loadWorkflows, a store that cannot be read is reported rather than read as
 * none: a list built on an empty snapshot would overwrite every stored workflow.
 */
export async function readWorkflowsForWrite(gatewayId: string): Promise<WorkflowStoreRead> {
  let raw: string | null;
  try {
    raw = await keyValueStorage.getItem(workflowsStorageKey(gatewayId));
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!raw) return { ok: true, workflows: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, error: 'the stored workflows are not valid JSON' };
  }
  // Anything but a list is not a store this app wrote; saving over it would destroy it.
  if (!Array.isArray(parsed)) {
    return { ok: false, error: 'the stored workflows are not a list' };
  }
  return { ok: true, workflows: workflowsFromUnknown(parsed) };
}

/**
 * Write this gateway's workflows back. Rejects when the store refuses the write,
 * so a caller that reports a save can tell it did not land.
 */
export async function saveWorkflows(gatewayId: string, workflows: Workflow[]): Promise<void> {
  await keyValueStorage.setItem(workflowsStorageKey(gatewayId), JSON.stringify(workflows));
}
