/**
 * The consolidated thread-config sheet (polish roadmap 2.2): sessions, models,
 * and chat backends used to be three separate sheets stacked off three header
 * triggers; they now share one host with a segmented switcher. This module is
 * the pure contract between that sheet and the visibility flags it multiplexes
 * — two provider-owned (modelPicker, sessionSelector) and one screen-local
 * (backend picker) — so the derivation stays node-testable.
 */

/** Which section of the consolidated thread-config sheet is active. */
export type ThreadConfigMode = 'sessions' | 'models' | 'backends';

export type ModelPickerMode = 'default' | 'fallbacks' | 'agent';

export type ThreadConfigVisibility = {
  sessionsVisible: boolean;
  modelsVisible: boolean;
  backendsVisible: boolean;
};

/**
 * Single source of truth for which thread-config section is open. The
 * consolidated sheet owns no visibility state of its own; it derives the mode
 * from the same flags the old separate sheets answered to, so provider-driven
 * opens (bot flows calling openModelPicker directly) keep working untouched.
 * Precedence mirrors the old stacked mount order in chat-screen (model picker
 * last-mounted won) so a same-tick race resolves exactly like before.
 */
export function resolveThreadConfigMode(
  visibility: ThreadConfigVisibility,
): ThreadConfigMode | null {
  if (visibility.modelsVisible) return 'models';
  if (visibility.sessionsVisible) return 'sessions';
  if (visibility.backendsVisible) return 'backends';
  return null;
}

/**
 * The backends section exists only on a configurable thread with a loaded
 * backend list. The sheet's offered modes AND chat-screen's guard that closes
 * an open backends section both derive from this one predicate: a single
 * source is what stops an active mode from outliving its availability (the
 * screen auto-navigating into a bot room, or a gateway refresh emptying the
 * list under an open sheet) and rendering a section its switcher no longer
 * offers.
 */
export function threadConfigBackendsAllowed(
  surfaceKind: string,
  backendsCount: number,
): boolean {
  return surfaceKind === 'configurable' && backendsCount > 0;
}

/** The sheet title per section; the models section keeps the picker's modes. */
export function threadConfigTitle(
  mode: ThreadConfigMode,
  modelMode?: ModelPickerMode,
  agentId?: string,
): string {
  switch (mode) {
    case 'sessions':
      return 'Sessions';
    case 'backends':
      return 'Chat backend';
    case 'models':
      if (modelMode === 'agent' && agentId) return `Model for agent ${agentId}`;
      if (modelMode === 'fallbacks') return 'Fallback models';
      return 'Apply model';
  }
}
