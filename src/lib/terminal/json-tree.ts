// Structured RPC output modelling.
//
// `GatewayCommand` results arrive as raw JSON. Rendering them as a monolithic
// mono string hides the shape. This module builds a stable tree view — typed
// leaves, collapsible containers, and an "exit signal" descriptor so the UI can
// accent a failed command — without the component owning any parsing logic.

export type JsonPrimitiveKind = 'string' | 'number' | 'boolean' | 'null';

export type JsonTreeNode =
  | { kind: 'primitive'; value: string; primitive: JsonPrimitiveKind }
  | { kind: 'object'; entries: { key: string; node: JsonTreeNode }[]; preview: string }
  | { kind: 'array'; children: JsonTreeNode[]; preview: string };

export function jsonTreeNode(value: unknown): JsonTreeNode {
  if (value === null || value === undefined || value === '') {
    return { kind: 'primitive', value: 'null', primitive: 'null' };
  }
  if (typeof value === 'string') {
    return { kind: 'primitive', value: JSON.stringify(value), primitive: 'string' };
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return { kind: 'primitive', value: String(value), primitive: 'number' };
  }
  if (typeof value === 'boolean') {
    return { kind: 'primitive', value: value ? 'true' : 'false', primitive: 'boolean' };
  }
  if (Array.isArray(value)) {
    const children = value.map(jsonTreeNode);
    const preview = children.length === 0 ? '[]' : `${children.length} item${children.length === 1 ? '' : 's'}`;
    return { kind: 'array', children, preview };
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value).map(([key, child]) => ({ key, node: jsonTreeNode(child) }));
    const preview = entries.length === 0 ? '{}' : `${entries.length} key${entries.length === 1 ? '' : 's'}`;
    return { kind: 'object', entries, preview };
  }
  // function/symbol/never: degenerate but not renderable — present as string.
  return { kind: 'primitive', value: String(value), primitive: 'string' };
}

/** Parse a log string as JSON; returns `null` when it is not JSON. */
export function tryParseJson(text: string): unknown | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

export type JsonExitSignal = {
  failed: boolean;
  label?: string;
};

/**
 * Read a command result's top-level shape for an exit narrative. A nonzero
 * `exitCode`, a non-empty `error`, `ok === false`, or a status outside the
 * success set all mark the output as failed so the sheet can accent it.
 */
export function jsonExitSignal(value: unknown): JsonExitSignal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { failed: false };
  }
  const record = value as Record<string, unknown>;

  const exitCode = record.exitCode ?? record.exit_code ?? record.code;
  const numericExit = typeof exitCode === 'number' ? exitCode : typeof exitCode === 'string' ? Number(exitCode) : undefined;
  if (numericExit !== undefined && !Number.isNaN(numericExit) && numericExit !== 0) {
    return { failed: true, label: `exit ${numericExit}` };
  }

  const error = record.error ?? record.message;
  const hasError = typeof error === 'string' && error.length > 0;
  if (hasError) {
    return { failed: true, label: typeof error === 'string' ? error.slice(0, 80) : 'error' };
  }

  if (record.ok === false) {
    return { failed: true, label: 'ok: false' };
  }

  const status = record.status ?? record.state;
  if (typeof status === 'string' && /^(?:running|queued|pending|warming|unknown)$/i.test(status)) {
    return { failed: true, label: status };
  }

  return { failed: false };
}

export type CommandResultModel =
  | { kind: 'empty' }
  | { kind: 'text'; text: string }
  | { kind: 'json'; value: unknown; signal: JsonExitSignal };

/** Classify a command log so the sheet and inline card share one render path. */
export function describeCommandResult(text: string): CommandResultModel {
  if (!text.trim()) return { kind: 'empty' };
  const parsed = tryParseJson(text);
  if (parsed === null) return { kind: 'text', text };
  return { kind: 'json', value: parsed, signal: jsonExitSignal(parsed) };
}
