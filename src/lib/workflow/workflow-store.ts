// ─── Saved workflows, keyed by gateway + name ──────────────────────
// FUTURE-ITEMS.md §Phase 5 "Runs become Workflows" (first slice): a completed
// run can be SAVED as a named workflow, client-side — a named prompt the
// operator can re-invoke later. No gateway route carries a workflow:
// `rpc-routes.ts` maps no workflow resource, so a workflow is THIS device's,
// held in key-value storage the way the session labels and command transcript
// are. A workflow never leaves the phone.
//
// The fold rules are the honesty rules, inherited from the precedent stores
// (`session-labels.ts`, `session-persistence.ts`): an unfinished run is not a
// workflow (nothing trustworthy to re-run yet), a blank name is not saved, an
// existing name is REJECTED rather than overwritten (the operator confirms
// replacement explicitly), and persistence is best-effort — a refused write
// is not a save, and never a crash in the screen that called it.

import { keyValueStorage } from '@/lib/storage/key-value';
import type { ActivityRun } from '@/lib/gateway/runs';

/** One saved workflow: a named prompt this device can re-invoke. */
export type SavedWorkflow = {
  id: string;
  /** The operator's own name — the identity inside the gateway's list. */
  name: string;
  /** The stored run's prompt, sent verbatim when the workflow is invoked. */
  prompt: string;
  /** The Bot the run was attributed to (D3 attribution kept, absent = unattributed). */
  botId?: string;
  /** When the workflow was saved, not when the run ran. */
  createdAt: number;
  /** How many times this workflow has been invoked. */
  runCount: number;
};

/** The one key the workflow blob is held under. */
export const SAVED_WORKFLOWS_STORAGE_KEY = 'versutus:saved-workflows';

/**
 * Cap matching the repo's other persisted surfaces
 * (`ACTIVITY_RUNS_PERSIST_CAP`, `ACTIVITY_EVENT_CAP`): a store that grows
 * without bound is the oldest entries' eviction problem, solved the same
 * way — oldest saved leaves first once the cap is reached.
 */
export const WORKFLOW_STORE_CAP = 40;

/** A save folded an already-known name — the store is unchanged. */
export class SavedWorkflowNameTakenError extends Error {
  constructor(name: string) {
    super(`A workflow named "${name}" is already saved for this gateway.`);
    this.name = 'SavedWorkflowNameTakenError';
  }
}

/** A run this fold refuses: blank name, not settled, or an unfinishable shape. */
export class SavedWorkflowNotSavableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'SavedWorkflowNotSavableError';
  }
}

/**
 * Whether an ActivityRun row is a trustworthy thing to fold into a workflow:
 * the run must be settled (the Activity tab's own vocabulary — a
 * `running`/`waiting-approval` row is still live, an `unresolved` row is
 * poll-abandoned, neither has a verdict) AND it must carry a `finishedAt`,
 * both facts agreeing, since a prompt saved from a half-row is a lie the
 * operator only discovers when they invoke it.
 */
function isSettledRun(run: ActivityRun): boolean {
  return run.status === 'complete' || run.status === 'failed' || run.status === 'cancelled'
    ? run.finishedAt !== undefined
    : false;
}

/**
 * Normalize the stored shape of one workflow, or undefined when it carries
 * junk. Every field is read on its own terms, the way
 * `normalizeSessionLabel` reads a label — a truncated write, a hand-edited
 * store, or a payload from an older shape can only ever lose a workflow,
 * never invent one.
 */
function normalizeSavedWorkflow(value: unknown): SavedWorkflow | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Partial<SavedWorkflow> & { runCount?: unknown; createdAt?: unknown };
  if (typeof raw.name !== 'string' || !raw.name.trim()) return undefined;
  if (typeof raw.prompt !== 'string' || !raw.prompt) return undefined;
  if (typeof raw.id !== 'string' || !raw.id) return undefined;
  const createdAt = typeof raw.createdAt === 'number' && raw.createdAt > 0 ? raw.createdAt : undefined;
  if (createdAt === undefined) return undefined;
  const runCount =
    typeof raw.runCount === 'number' && Number.isFinite(raw.runCount) && raw.runCount >= 0
      ? raw.runCount
      : 0;
  const next: SavedWorkflow = {
    id: raw.id,
    name: raw.name,
    prompt: raw.prompt,
    createdAt,
    runCount,
  };
  if (typeof raw.botId === 'string' && raw.botId) next.botId = raw.botId;
  return next;
}

/**
 * Read one gateway's stored workflows, newest saved first. A blob that is
 * not a record, an unreadable store, or an entry that fails normalization
 * reads as fewer-or-no workflows — never an invented one.
 */
export function workflowsFromUnknown(value: unknown, gatewayId: string): SavedWorkflow[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const entries = (value as Record<string, unknown>)[gatewayId];
  if (!Array.isArray(entries)) return [];
  const workflows: SavedWorkflow[] = [];
  for (const entry of entries) {
    const workflow = normalizeSavedWorkflow(entry);
    if (workflow) workflows.push(workflow);
  }
  return workflows;
}

/**
 * `w`'s id in the store: the workflow's own id is its identity across
 * re-invoke bookkeeping, so it is the run it was saved from never — the
 * saved workflow's identity is its own, minted at save time.
 */
function newWorkflowId(): string {
  return `wf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** The store's id is gateway-scoped exactly as the session-label key is. */
function scopeKey(gatewayId: string, name: string): string {
  return `${gatewayId}:${name}`;
}

/**
 * Save a finished run as a workflow named by the operator. The run's
 * prompt and its Bot's attribution (`botId`, D3) are the fold; the run's
 * events, statuses and timings are the row's, not the workflow's. An
 * existing name in this gateway's list is refused, not overwritten — a
 * replace must be an explicit operator action on a surfaced workflow (a
 * future surface's call to `deleteWorkflow` then a fresh save). The store
 * is capped and best-effort persisted; a refused write is WRONG but not a
 * crash — the caller answers `null` and keeps the run row as it was.
 */
export async function saveWorkflowFromRun(input: {
  run: ActivityRun;
  name: string;
  gatewayId: string;
  now?: number;
}): Promise<SavedWorkflow | null> {
  const name = input.name.trim();
  if (!name) throw new SavedWorkflowNotSavableError('A workflow needs a name from the operator.');
  if (!name) return null;
  if (!isSettledRun(input.run)) {
    throw new SavedWorkflowNotSavableError(
      `Run ${input.run.id} (${input.run.status}) has not settled — nothing trustworthy to fold.`,
    );
  }
  return writeWorkflow(input.gatewayId, (workflows) => {
    if (workflows.some((existing) => existing.name.toLowerCase() === name.toLowerCase())) {
      throw new SavedWorkflowNameTakenError(name);
    }
    const workflow: SavedWorkflow = {
      id: newWorkflowId(),
      name,
      prompt: input.run.prompt,
      ...(input.run.botId ? { botId: input.run.botId } : {}),
      createdAt: input.now ?? Date.now(),
      runCount: 0,
    };
    return [workflow, ...workflows].slice(0, WORKFLOW_STORE_CAP);
  });
}

/**
 * Drop one workflow by name. A name this gateway's store does not hold is
 * not an error and not a write — `false` says so; `true` was a write. The
 * other gateways' lists are untouched.
 */
export async function deleteWorkflow(gatewayId: string, name: string): Promise<boolean> {
  let removed = false;
  const next = await foldStore(gatewayId, (workflows) => {
    const kept = workflows.filter((workflow) => {
      if (workflow.name.toLowerCase() === name.toLowerCase() && !removed) {
        removed = true;
        return false;
      }
      return true;
    });
    return removed ? kept : workflows;
  });
  if (!removed) return false;
  return persist(next);
}

/**
 * The one gateway-scoped read: the newest saved workflow leads. Missing blob
 * key, unreadable blob, or a store that refuses the read all answer `[]` —
 * the same "no labels" / "no labels" answers their sibling stores give.
 */
export async function loadWorkflows(gatewayId: string): Promise<SavedWorkflow[]> {
  const blob = await readBlob();
  return workflowsFromUnknown(blob, gatewayId);
}

// ─── internals ─────────────────────────────────────────────────────

async function readBlob(): Promise<unknown> {
  try {
    const raw = await keyValueStorage.getItem(SAVED_WORKFLOWS_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

async function foldStore(
  gatewayId: string,
  fold: (workflows: SavedWorkflow[]) => SavedWorkflow[],
): Promise<Record<string, SavedWorkflow[]>> {
  const blob = await readBlob();
  const workflows = workflowsFromUnknown(blob, gatewayId);
  const next = fold(workflows);
  const store =
    blob && typeof blob === 'object' && !Array.isArray(blob)
      ? (blob as Record<string, SavedWorkflow[]>)
      : {};
  return { ...store, [gatewayId]: next };
}

async function persist(store: Record<string, SavedWorkflow[]>): Promise<boolean> {
  try {
    await keyValueStorage.setItem(SAVED_WORKFLOWS_STORAGE_KEY, JSON.stringify(store));
    return true;
  } catch {
    // Best-effort, like the session labels — a lock must not crash the screen.
    return false;
  }
}

async function writeWorkflow(
  gatewayId: string,
  fold: (workflows: SavedWorkflow[]) => SavedWorkflow[],
): Promise<SavedWorkflow | null> {
  const store = await foldStore(gatewayId, fold);
  const ok = await persist(store);
  if (!ok) return null;
  const [newest] = store[gatewayId];
  return newest ?? null;
}
