import type { RoutineDraft } from './routines';

/**
 * One one-tap routine pack: a name the operator recognises, a line saying
 * what the routine it sets up will do, and the `RoutineDraft` it prefills.
 * D4's packs are an onboarding surface — the operator taps one, edits
 * anything it got wrong, and the existing Add is still the only thing that
 * creates anything.
 *
 * `draft` is the pack's own object, so the fold below hands back a copy: a
 * pack tapped, edited and added must not rewrite what every later tap of the
 * same pack starts from.
 */
export type RoutineTemplate = {
  /** Stable identity for the pack row, and the key the fold resolves. */
  key: string;
  label: string;
  /** One line naming the routine this pack sets up. */
  description: string;
  draft: RoutineDraft;
};

/**
 * D4's packs, in the order the pane lists them. Each schedule is the pack's
 * own sane default as a plain five-field cron — a daily morning digest,
 * weekday triage, a half-hourly watchdog, a Friday review — so the gateway's
 * create path accepts it unchanged.
 */
export const ROUTINE_TEMPLATES: readonly RoutineTemplate[] = [
  {
    key: 'morning-briefing',
    label: 'Morning briefing',
    description: 'A daily digest of what happened overnight',
    draft: {
      title: 'Morning briefing',
      prompt: 'Summarize what happened overnight and anything that needs me today.',
      schedule: '0 8 * * *',
    },
  },
  {
    key: 'inbox-triage',
    label: 'Inbox triage',
    description: 'Sort new mail on weekday mornings',
    draft: {
      title: 'Inbox triage',
      prompt: 'Review new mail, sort it by what needs a reply, and draft the urgent replies.',
      schedule: '0 9 * * 1-5',
    },
  },
  {
    key: 'server-watchdog',
    label: 'Server watchdog',
    description: 'Check the host every half hour',
    draft: {
      title: 'Server watchdog',
      prompt: 'Check host health and report anything failing or degraded since the last check.',
      schedule: '*/30 * * * *',
    },
  },
  {
    key: 'weekly-code-review',
    label: 'Weekly code review',
    description: "A Friday review of the week's changes",
    draft: {
      title: 'Weekly code review',
      prompt: "Review this week's commits and flag anything risky, unfinished, or worth a follow-up.",
      schedule: '0 17 * * 5',
    },
  },
];

/** The pack a key names, or undefined when no pack carries it. */
export function routineTemplateByKey(key: string): RoutineTemplate | undefined {
  return ROUTINE_TEMPLATES.find((template) => template.key === key);
}

/**
 * The draft a tapped pack prefills: every field the pack sets, with nothing
 * merged in from the draft it replaces. A key that names no pack hands the
 * draft straight back — a tap that cannot resolve a pack leaves the form as
 * it was rather than blanking it.
 */
export function applyRoutineTemplate(draft: RoutineDraft, key: string): RoutineDraft {
  const template = routineTemplateByKey(key);
  if (!template) return draft;
  return { ...template.draft };
}
