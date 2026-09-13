/**
 * What the Android widget renders, folded in JS by `androidWidgetPayload` from
 * the same snapshot and lines the iOS widget uses. Versioned so a native side
 * that meets a newer shape draws its "update Versutus" state instead of garbage.
 */
export type VersutusWidgetPayload = {
  v: 1;
  /** The connection word the app shows, e.g. "Connected". */
  status: string;
  /** Whether that word means connected — drives the status dot colour. */
  connected: boolean;
  /** Approvals first, then runs in flight, e.g. "1 run waiting on your approval". */
  work: string;
  /** Present only when a judged outcome exists. */
  result?: string;
  /** How many runs wait on the operator; > 0 shows the approval call to action. */
  approvalsPending: number;
  /** Epoch milliseconds the snapshot was true at. The widget formats the stamp itself. */
  writtenAt: number;
};
