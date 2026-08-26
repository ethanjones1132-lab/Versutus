/** One toolset the gateway reports. Name is required; description may be empty. */
export type Toolset = {
  name: string;
  description: string;
};

/** What one toolsets list read produced. */
export type ToolsetsRead = { ok: true; toolsets: Toolset[] } | { ok: false };

/**
 * Visible toolsets after folding a read. Two failures are not the same
 * fact:
 *   - A failed FIRST read claims zero knowledge — not "no tools".
 *   - A failed RE-read keeps the last good list and marks it stale.
 * Only a successful read may clear or replace the list.
 */
export type ToolsetsState = {
  toolsets: Toolset[];
  /** True once a successful read has landed. */
  loaded: boolean;
  failed: boolean;
};

export const EMPTY_TOOLSETS: ToolsetsState = { toolsets: [], loaded: false, failed: false };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function toolsDescription(raw: Record<string, unknown>): string {
  const description = stringField(raw, 'description');
  if (description) return description.trim();
  const tools = raw.tools;
  if (!Array.isArray(tools)) return '';
  return tools.filter((item): item is string => typeof item === 'string').join(', ');
}

function parseToolset(raw: unknown): Toolset | null {
  if (!isRecord(raw)) return null;
  const name = (stringField(raw, 'name') ?? stringField(raw, 'id') ?? '').trim();
  if (!name) return null;
  return { name, description: toolsDescription(raw) };
}

function toolsetItems(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw;
  if (!isRecord(raw)) return null;
  if (Array.isArray(raw.toolsets)) return raw.toolsets;
  if (Array.isArray(raw.data)) return raw.data;
  return null;
}

/**
 * Parse a tools.list / GET /v1/toolsets payload. The Gate returns
 * `{ toolsets }`. Hermes may return a raw array or `{ data }`. Anything
 * else is a failed read — never an empty-ok list — so a junk envelope
 * cannot render as "no tools". Do not unwrap `plugins`; that list is
 * host-side.
 */
export function toolsetsReadFromUnknown(raw: unknown): ToolsetsRead {
  const items = toolsetItems(raw);
  if (!items) return { ok: false };
  const toolsets: Toolset[] = [];
  for (const item of items) {
    const toolset = parseToolset(item);
    if (toolset) toolsets.push(toolset);
  }
  return { ok: true, toolsets };
}

export function applyToolsetsRead(previous: ToolsetsState, read: ToolsetsRead): ToolsetsState {
  if (read.ok) return { toolsets: read.toolsets, loaded: true, failed: false };
  if (previous.loaded) return { toolsets: previous.toolsets, loaded: true, failed: true };
  return { toolsets: [], loaded: false, failed: true };
}

export function toolsetsToggleLabel(state: ToolsetsState, open: boolean): string {
  if (open) return 'Hide tools';
  if (!state.loaded) return 'Tools';
  return `Tools (${state.toolsets.length})`;
}

export function toolsetsListCopy(state: ToolsetsState): string | undefined {
  if (!state.loaded && state.failed) return 'Tools could not be read.';
  if (state.failed) return 'Could not re-read tools — showing the last list.';
  if (state.loaded && state.toolsets.length === 0) return 'No tools.';
  return undefined;
}

/**
 * Tools belong to the CLI environment, not to a Bot. Skills stay Bot-only;
 * copying that gate would hide this catalog from configurable chat.
 */
export function toolsetsVisibleOn(surface: { kind: string }): boolean {
  return surface.kind === 'configurable' || surface.kind === 'bot';
}

/**
 * Configurable chat pins tools.list to the selected backend so a Codex or
 * Claude environment is a failed read (it has no listToolsets), not
 * Hermes's catalog. Bot Chat leaves the request unpinned: a Bot is a
 * Hermes profile, and the Gate resolves listToolsets by capability.
 */
export function toolsetsListParams(input: {
  surfaceKind: string;
  backendId: string | undefined;
}): Record<string, unknown> {
  if (input.surfaceKind === 'configurable' && input.backendId) {
    return { backendId: input.backendId };
  }
  return {};
}
