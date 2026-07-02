export type TerminalMode = 'shell' | 'rpc' | 'agent';

export const TERMINAL_MODES: { id: TerminalMode; label: string }[] = [
  { id: 'shell', label: 'Shell' },
  { id: 'rpc', label: 'Gateway RPC' },
  { id: 'agent', label: 'Agent' },
];