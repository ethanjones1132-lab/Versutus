/**
 * What the Android widget renders, folded in JS by `androidWidgetPayload` from
 * the same snapshot and lines the iOS widget uses. Versioned so a native side
 * that meets a newer shape draws its "update Versutus" state instead of garbage.
 */
/** A run in flight as the large Android cell lists it. */
export type VersutusWidgetRun = { title: string; state: string };

/** One quick-launch Bot row: the id to open, and the name to draw. */
export type VersutusWidgetBot = { id: string; label: string };

export type VersutusWidgetPayload = {
  v: 1 | 2;
  /** The connection word the app shows, e.g. "Connected". */
  status: string;
  /** Whether that word means connected — drives the status dot colour. */
  connected: boolean;
  /** Approvals first, then runs in flight, e.g. "1 run waiting on your approval". */
  work: string;
  /** Present only when a judged outcome exists. */
  result?: string;
  /** Version 2: up to three in-flight runs for the large cell. */
  runs?: VersutusWidgetRun[];
  /** Version 2: up to three recent Bots for the quick-launch rows. */
  bots?: VersutusWidgetBot[];
  /** True when the device asked for the result and Bot names to stay off the card. */
  redact?: boolean;
  /** How many runs wait on the operator; > 0 shows the approval call to action. */
  approvalsPending: number;
  /** Epoch milliseconds the snapshot was true at. The widget formats the stamp itself. */
  writtenAt: number;
};
