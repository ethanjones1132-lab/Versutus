export type TerminalMode = 'shell' | 'rpc' | 'agent';

export const TERMINAL_MODES: { id: TerminalMode; label: string }[] = [
  { id: 'shell', label: 'Shell' },
  { id: 'rpc', label: 'Commands' },
  { id: 'agent', label: 'Agent' },
];