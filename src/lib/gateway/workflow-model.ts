// ─── Workflows: the pure definition and folds ─────────────────────────────
// `FUTURE-ITEMS.md` ("Runs become Workflows"): a named, reusable step sequence
// a slash command references and re-invokes. This module is deliberately free
// of storage so the dispatcher can fold a workflow without pulling the
// key-value store into its import graph; `workflows.ts` adds the per-gateway
// persistence.

export type WorkflowStep = {
  id: string;
  prompt: string;
  /** The Bot this step runs for, when the workflow pins one. */
  botId?: string;
};

export type Workflow = {
  id: string;
  name: string;
  steps: WorkflowStep[];
  /**
   * How many times `/workflow <name>` has run it from this device, with the
   * stamp of the last run. Absent on a workflow the device has never run (or
   * one stored before these fields existed) — not a zero.
   */
  runCount?: number;
  lastRunAt?: number;
};

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stepsFromUnknown(value: unknown): WorkflowStep[] {
  if (!Array.isArray(value)) return [];
  const steps: WorkflowStep[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const record = raw as Record<string, unknown>;
    const id = text(record.id);
    const prompt = text(record.prompt);
    if (!id || !prompt) continue;
    const step: WorkflowStep = { id, prompt };
    const botId = text(record.botId);
    if (botId) step.botId = botId;
    steps.push(step);
  }
  return steps;
}

/** Keep only real workflows: an id, a name, and at least one step. */
export function workflowsFromUnknown(value: unknown): Workflow[] {
  if (!Array.isArray(value)) return [];
  const workflows: Workflow[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const record = raw as Record<string, unknown>;
    const id = text(record.id);
    const name = text(record.name);
    const steps = stepsFromUnknown(record.steps);
    if (!id || !name || steps.length === 0) continue;
    const workflow: Workflow = { id, name, steps };
    // Stored shapes older than the run tally read as never-run, not zero.
    const runCount = typeof record.runCount === 'number' && record.runCount >= 0 ? record.runCount : undefined;
    const lastRunAt = typeof record.lastRunAt === 'number' ? record.lastRunAt : undefined;
    if (runCount !== undefined) workflow.runCount = runCount;
    if (lastRunAt !== undefined) workflow.lastRunAt = lastRunAt;
    workflows.push(workflow);
  }
  return workflows;
}

/** Add a workflow. An empty name or no non-blank steps changes nothing. */
export function createWorkflow(
  workflows: Workflow[],
  input: { name: string; steps: string[]; botId?: string },
  makeId: () => string = () => Math.random().toString(36).slice(2),
): Workflow[] {
  const name = input.name.trim();
  const steps = input.steps
    .map((prompt) => prompt.trim())
    .filter((prompt) => prompt.length > 0)
    .map((prompt): WorkflowStep => ({
      id: makeId(),
      prompt,
      ...(input.botId ? { botId: input.botId } : {}),
    }));
  if (!name || steps.length === 0) return workflows;
  return [...workflows, { id: makeId(), name, steps }];
}

/** Rename one workflow. A blank name keeps the old one. */
export function renameWorkflow(workflows: Workflow[], id: string, name: string): Workflow[] {
  const next = name.trim();
  if (!next) return workflows;
  return workflows.map((workflow) => (workflow.id === id ? { ...workflow, name: next } : workflow));
}

export function deleteWorkflow(workflows: Workflow[], id: string): Workflow[] {
  return workflows.filter((workflow) => workflow.id !== id);
}

/** The workflow a `/workflow <name>` names, by trimmed, case-insensitive name. */
export function findWorkflow(workflows: Workflow[], name: string): Workflow | undefined {
  const needle = name.trim().toLowerCase();
  if (!needle) return undefined;
  return workflows.find((workflow) => workflow.name.toLowerCase() === needle);
}

/** Replace every `{{input}}` with the command's argument; no input keeps it. */
export function applyWorkflowInput(prompt: string, input: string): string {
  const value = input.trim();
  return value ? prompt.split('{{input}}').join(value) : prompt;
}

/** One row's line in the workflow list. */
export function workflowSummaryCopy(workflow: Workflow): string {
  const count = workflow.steps.length;
  return `${workflow.name}: ${count} ${count === 1 ? 'step' : 'steps'}`;
}

/**
 * Fold one completed run of a workflow into the stored set. Unchanged when no
 * workflow matches — a run can only ever tally the name that started it.
 */
export function recordWorkflowRun(
  workflows: Workflow[],
  id: string,
  ranAt: number = Date.now(),
): Workflow[] {
  return workflows.map((workflow) =>
    workflow.id === id
      ? { ...workflow, runCount: (workflow.runCount ?? 0) + 1, lastRunAt: ranAt }
      : workflow,
  );
}
