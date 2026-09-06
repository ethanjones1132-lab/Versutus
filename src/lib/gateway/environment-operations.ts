/**
 * Which CLI operations the run launcher may offer.
 *
 * The Gate serves the per-environment command catalog through
 * `environments.commands.list`; the launcher used to hardcode
 * `['prompt', 'status']`, which hides adapters whose verb differs
 * (Codex serves `exec`, not `prompt`) and can offer a verb the Gate
 * will reject. Interactive operations stay hidden: the adapter marks
 * them non-machine-readable because they expect a real terminal.
 */

export type CommandCatalogEntry = {
  machineReadable?: boolean;
  risk?: string;
};

export type CommandCatalog = Record<string, CommandCatalogEntry>;

/** What the launcher offers when the catalog cannot be read. */
export const DEFAULT_LAUNCHER_OPERATIONS = ['prompt', 'status'] as const;

/**
 * Machine-readable operation names in catalog order. Falls back to the
 * prompt/status pair when the catalog is missing, empty, or names no
 * machine-readable operation — so prompt/status runs behave exactly as
 * today even when the catalog read fails.
 */
export function resolveLauncherOperations(catalog: CommandCatalog | null | undefined): string[] {
  if (!catalog) return [...DEFAULT_LAUNCHER_OPERATIONS];
  const offered = Object.entries(catalog)
    .filter(([, entry]) => entry?.machineReadable === true)
    .map(([name]) => name);
  return offered.length > 0 ? offered : [...DEFAULT_LAUNCHER_OPERATIONS];
}

/**
 * Whether starting this operation needs the prompt text field. Only the
 * known prompt-taking verbs do; status-like verbs run with an empty input.
 */
export function operationNeedsPromptInput(operation: string): boolean {
  return operation === 'prompt' || operation === 'exec';
}
