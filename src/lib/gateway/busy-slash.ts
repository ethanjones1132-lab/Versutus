// Decision for a slash command typed while another command is running.
// The provider's concurrency guard (`isCommandRunning`) is the source of
// truth and must keep running the gate; this helper only turns the busy
// state into the visible feedback that replaces the old silent return.

export type BusySlashDecision =
  | { kind: 'run' }
  | { kind: 'busy'; note: string };

export function decideBusySlash(
  input: string,
  isCommandRunning: boolean,
  runningCommandLabel?: string | null,
): BusySlashDecision {
  if (!isCommandRunning) {
    return { kind: 'run' };
  }
  const trimmed = input.trim();
  const naming = runningCommandLabel ? `A command (${runningCommandLabel}) is still running` : 'A command is still running';
  return {
    kind: 'busy',
    note: `${trimmed} was not sent. ${naming}; wait for it to finish, then send it again.`,
  };
}