// ─── Bot detail: the roster row's "who is this, can it route, why not" ──
//
// The roster subtitle is one line by design (see botRowSubtitle) — the
// description and the routing FIX belong to a detail surface. This module is
// that surface's entire decision logic, kept pure so the sheet component
// only lays out what the Gate already reported. No new Gate calls: every
// field comes off PublicBot, so older Gates degrade exactly like the row
// does (absent fields render as honest absences, never invented text).

import type { PublicBot } from './bots';

import { routingFailureView } from './run-failures';

/** What the detail sheet shows for one Bot. */
export type BotDetailView = {
  name: string;
  /** The Hermes profile id — what host-side commands address (`hermes -p <id>`). */
  id: string;
  /** Gate-reported description; null when absent (older Gates or unset). */
  description: string | null;
  /**
   * The model pin as one readable line ("model · provider"). Null when the
   * profile carries no pin the Gate can see — meaning the gateway default
   * applies, which the surface says out loud.
   */
  modelPin: string | null;
  /** Routing verdict title, shared with the run-failure vocabulary. */
  routingTitle: string;
  /** The fix, present only when the Bot cannot route. */
  routingNext?: string;
  /**
   * Whether this surface offers "Edit agent". The Gate refuses every write
   * against the default profile (ADR 0011: it is not a bot), so the sheet
   * hides the affordance there instead of inviting a guaranteed refusal.
   */
  editable: boolean;
};

/**
 * The model pin line: join the parts the Gate actually reported. A
 * provider-only pin is still information on the detail surface (the roster
 * hides it behind plain "Bot"), so it shows alone rather than collapsing to
 * null.
 */
function modelPinLine(bot: PublicBot): string | null {
  const parts = [bot.model?.default ?? null, bot.model?.provider ?? null].filter(
    (part): part is string => typeof part === 'string' && part.length > 0,
  );
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** Routing verdict with the same precedence the roster row uses. */
export function botRoutingView(bot: Pick<PublicBot, 'routable' | 'routingIssue'>): {
  title: string;
  next?: string;
} {
  if (bot.routingIssue === 'default_key_refused') return routingFailureView('default_key_refused');
  if (!bot.routable || bot.routingIssue === 'listen_key_missing') {
    return routingFailureView('listen_key_missing');
  }
  return { title: 'Routable' };
}

export function describeBotDetail(bot: PublicBot): BotDetailView {
  const routing = botRoutingView(bot);
  return {
    name: bot.displayName,
    id: bot.id,
    description: bot.description ?? null,
    modelPin: modelPinLine(bot),
    routingTitle: routing.title,
    routingNext: routing.next,
    editable: bot.id !== 'default',
  };
}
