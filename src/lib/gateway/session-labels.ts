// ─── Session pins and names, keyed by gateway + session ───────────
// P3 (`FUTURE-ITEMS.md:523-531`): the selector lists a Bot's sessions and
// can neither pin one nor rename one. No gateway route can carry either —
// `rpc-routes.ts` maps no session update, and `manifest-client.ts` patches
// only Bots and groups — so a pin and a rename are THIS device's, held in
// key-value storage the way the command transcript is. A label never leaves
// the phone.
//
// The fold rules are the honesty rules: a blank rename clears the name
// rather than printing an empty row, a stored blob that is not what it
// claims to be reads as no label at all, and persistence is best-effort —
// a refused write must never break the selector it was called from.

import { keyValueStorage } from '@/lib/storage/key-value';
import { sessionListTitle } from '@/lib/gateway/session-list';

/** One session's device-local label. Neither field is required. */
export type SessionLabel = {
  /** The operator pinned this thread to the top of the selector. */
  pinned?: boolean;
  /** The operator's own name for the thread, replacing the gateway title. */
  label?: string;
};

/** The one key the label blob is held under. */
export const SESSION_LABELS_STORAGE_KEY = 'versutus:session-labels';

/**
 * One session's identity inside the label store. The session id is
 * normalized the way the command transcript normalizes its storage key
 * (`[:/\\]` -> `_`) so a gateway that hands back a path-shaped session key
 * cannot produce a nested location, and the gateway id is folded in so two
 * gateways' sessions cannot share one label.
 */
export function sessionLabelKey(gatewayId: string, sessionId: string): string {
  return `${gatewayId}:${sessionId.replace(/[:/\\]/g, '_')}`;
}

/**
 * The stored shape of one label, or undefined when it carries nothing.
 * Exactly two fields are read, each on its own terms: a pin must be `true`
 * (a truthy-but-not-true value is not a pin), and a name must be a
 * non-blank string. Everything else is dropped rather than guessed, so an
 * entry holding only junk leaves the session unlabelled.
 */
function normalizeSessionLabel(value: SessionLabel): SessionLabel | undefined {
  const next: SessionLabel = {};
  if (value.pinned === true) next.pinned = true;
  if (typeof value.label === 'string' && value.label.trim()) next.label = value.label.trim();
  const { pinned, label } = next;
  if (pinned === undefined && label === undefined) return undefined;
  return next;
}

/**
 * Fold one patch onto a session's label: `pinned` and `label` merge, so
 * pinning a renamed thread keeps the name and renaming a pinned thread
 * keeps the pin. A patch that leaves the entry carrying nothing drops the
 * key entirely — that is how a blank rename clears a name, rather than
 * storing a row that would print as empty.
 */
export function applySessionLabel(
  labels: Record<string, SessionLabel>,
  key: string,
  patch: SessionLabel,
): Record<string, SessionLabel> {
  const next = normalizeSessionLabel({ ...labels[key], ...patch });
  if (!next) return clearSessionLabel(labels, key);
  return { ...labels, [key]: next };
}

/** Drop one session's label. A key that is not there is returned untouched. */
export function clearSessionLabel(
  labels: Record<string, SessionLabel>,
  key: string,
): Record<string, SessionLabel> {
  if (!(key in labels)) return labels;
  const next = { ...labels };
  delete next[key];
  return next;
}

/**
 * Read a stored blob. A blob that is not a record reads as no labels at
 * all, and each entry is normalized on its own terms — so a truncated
 * write, a hand-edited store, or a payload from an older shape can only
 * ever lose a label, never invent one.
 */
export function sessionLabelsFromUnknown(value: unknown): Record<string, SessionLabel> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const labels: Record<string, SessionLabel> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const label = normalizeSessionLabel(entry as SessionLabel);
    if (label) labels[key] = label;
  }
  return labels;
}

/**
 * What the selector prints for a session: the operator's own name when they
 * gave one, and the gateway's title otherwise — through the shipped
 * `sessionListTitle`, so an unlabelled session still reads `Untitled` and
 * there is exactly one fallback rule in the repo.
 */
export function sessionLabelTitle(
  gatewayTitle: string | null | undefined,
  label: SessionLabel | undefined,
): string {
  const named = label ? normalizeSessionLabel(label)?.label : undefined;
  return named ?? sessionListTitle(gatewayTitle);
}

/** Read every stored label. A refused or unreadable store is no labels. */
export async function loadSessionLabels(): Promise<Record<string, SessionLabel>> {
  try {
    const raw = await keyValueStorage.getItem(SESSION_LABELS_STORAGE_KEY);
    if (!raw) return {};
    return sessionLabelsFromUnknown(JSON.parse(raw) as unknown);
  } catch {
    return {};
  }
}

/** Write the label set back. Best-effort, like the composer draft. */
export async function saveSessionLabels(labels: Record<string, SessionLabel>): Promise<void> {
  try {
    await keyValueStorage.setItem(SESSION_LABELS_STORAGE_KEY, JSON.stringify(labels));
  } catch {
    // best-effort: a label must never break the selector
  }
}
