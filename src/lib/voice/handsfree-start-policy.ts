// ─── What stands between the operator and a hands-free call ──────────────
// The Call control used to vanish whenever a reply streamed, a command ran or
// an approval waited — the opposite of the hold-to-talk mic, which stays put so
// a reply arriving is never what takes voice away (mic-state.ts). The control
// now stays offered; a start that cannot proceed yet names the reason.

export type HandsfreeStartBlocker = 'disconnected' | 'approval' | 'command' | 'streaming';

export type HandsfreeStartInputs = {
  status: string;
  isSending: boolean;
  isCommandRunning: boolean;
  pendingApproval: boolean;
};

/** The single most important reason a call cannot start now, or null. */
export function handsfreeStartBlocker(inputs: HandsfreeStartInputs): HandsfreeStartBlocker | null {
  if (inputs.status !== 'connected') return 'disconnected';
  if (inputs.pendingApproval) return 'approval';
  if (inputs.isCommandRunning) return 'command';
  if (inputs.isSending) return 'streaming';
  return null;
}

const COPY: Record<HandsfreeStartBlocker, string> = {
  disconnected: 'Versutus is not connected to the gateway yet. The call can start once it reconnects.',
  approval: 'A run is waiting for your approval. Decide it first, then start the call.',
  command: 'A command is still running. Start the call when it finishes.',
  streaming: 'Wait for this reply to finish, or stop it, then start the call.',
};

export function handsfreeStartBlockerCopy(blocker: HandsfreeStartBlocker): string {
  return COPY[blocker];
}
