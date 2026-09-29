/**
 * Activity at a glance: three numbers in the operator's words, and the last
 * day of work as a ribbon of light — every run a bead in its Bot's colour,
 * set where in the day it started.
 *
 * Pure, so the screen only draws what these functions decide.
 */

import type { ActivityRun } from '@/lib/gateway/runs';

export const DAY_MS = 24 * 60 * 60 * 1000;

export type GlanceFigure = {
  key: 'needs-you' | 'working' | 'done' | 'failed';
  value: number;
  label: string;
};

/**
 * The glance's figures. "Needs you" is the approval inbox's count — the same
 * number the drawer carries — so a run waiting on an approval is not counted
 * twice. "Failed" appears only when something did, so a good day reads as
 * three calm numbers.
 */
export function glanceFigures(pendingApprovals: number, runs: ActivityRun[], now: number): GlanceFigure[] {
  const since = now - DAY_MS;
  const endedToday = (run: ActivityRun) => (run.finishedAt ?? run.startedAt) >= since;
  const working = runs.filter((run) => run.status === 'running').length;
  const done = runs.filter((run) => run.status === 'complete' && endedToday(run)).length;
  const failed = runs.filter((run) => run.status === 'failed' && endedToday(run)).length;
  const figures: GlanceFigure[] = [
    { key: 'needs-you', value: Math.max(0, pendingApprovals), label: 'needs you' },
    { key: 'working', value: working, label: 'working' },
    { key: 'done', value: done, label: 'done today' },
  ];
  if (failed > 0) figures.push({ key: 'failed', value: failed, label: 'failed' });
  return figures;
}

/**
 * Where a moment sits on the ribbon: 0 a day ago, 1 now. The scale is in
 * perspective — square-root time — so the last hour gets a fifth of the line
 * and the last six hours half of it, and a busy afternoon does not pile up at
 * "now". The ticks below say so honestly.
 */
export function ribbonPosition(ageMs: number, spanMs: number = DAY_MS): number {
  const age = Math.min(1, Math.max(0, ageMs / spanMs));
  return 1 - Math.sqrt(age);
}

/** The ticks that make the perspective scale readable. */
export const RIBBON_TICKS: readonly { label: string; at: number }[] = [
  { label: '6h', at: ribbonPosition(6 * 60 * 60 * 1000) },
  { label: '1h', at: ribbonPosition(60 * 60 * 1000) },
];

export type RibbonBead = {
  id: string;
  botId?: string;
  /** 0 at the left edge (a day ago) … 1 at the right (now). */
  at: number;
  /** A waiting run carries the one attention mark; a working one glows. */
  state: 'waiting' | 'working' | 'settled';
};

/**
 * The day's runs as beads on a line, oldest left. Runs older than a day fall
 * off the ribbon; a run started "in the future" (a skewed clock) sits at now.
 */
export function dayRibbon(runs: ActivityRun[], now: number, spanMs: number = DAY_MS): RibbonBead[] {
  return runs
    .filter((run) => run.startedAt >= now - spanMs)
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((run) => ({
      id: run.id,
      botId: run.botId,
      at: ribbonPosition(now - run.startedAt, spanMs),
      state: run.status === 'waiting-approval' ? 'waiting' : run.status === 'running' ? 'working' : 'settled',
    }));
}
