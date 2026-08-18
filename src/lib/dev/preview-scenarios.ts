import type { ConnectionPhase } from '@/context/gateway-provider';
import type { ChatMessage, ConnectionStatus } from '@/lib/gateway/types';

export type PreviewScenario =
  | 'idle'
  | 'searching'
  | 'connecting'
  | 'pairing'
  | 'connected'
  | 'failed'
  | 'chat-streaming';

export type PreviewScenarioMeta = {
  id: PreviewScenario;
  label: string;
  status: ConnectionStatus;
  phase: ConnectionPhase;
  statusDetail: string;
  probeMessage?: string;
  showPairing: boolean;
  lastError?: string;
};

export const PREVIEW_SCENARIOS: PreviewScenarioMeta[] = [
  {
    id: 'idle',
    label: 'Idle',
    status: 'disconnected',
    phase: 'idle',
    statusDetail: 'Versutus connects to OpenClaw on your PC over Tailscale.',
    showPairing: false,
  },
  {
    id: 'searching',
    label: 'Searching',
    status: 'connecting',
    phase: 'searching',
    statusDetail: 'Looking for your gateway over Tailscale and local network…',
    showPairing: false,
  },
  {
    id: 'connecting',
    label: 'Connecting',
    status: 'connecting',
    phase: 'connecting',
    statusDetail: 'Connecting to your agent…',
    showPairing: false,
  },
  {
    id: 'pairing',
    label: 'Pairing',
    status: 'pairing',
    phase: 'pairing',
    statusDetail: 'Almost there — approve this device once on your PC.',
    showPairing: true,
  },
  {
    id: 'connected',
    label: 'Connected',
    status: 'connected',
    phase: 'connected',
    statusDetail: 'You are connected. Chat is ready.',
    showPairing: false,
  },
  {
    id: 'failed',
    label: 'Failed',
    status: 'disconnected',
    phase: 'failed',
    statusDetail: 'Could not reach your gateway.',
    showPairing: false,
    lastError: 'Gateway unreachable — check Tailscale and OpenClaw on your PC.',
  },
  {
    id: 'chat-streaming',
    label: 'Chat stream',
    status: 'connected',
    phase: 'connected',
    statusDetail: 'Assistant is responding…',
    showPairing: false,
  },
];

export const MOCK_DEVICE_ID = 'versutus-preview-device-7f3a';

export const MOCK_CHAT_MESSAGES: ChatMessage[] = [
  {
    id: 'preview-user-1',
    role: 'user',
    text: 'What can you help me with on this machine?',
    timestamp: Date.now() - 86_400_000,
  },
  {
    id: 'preview-assistant-1',
    role: 'assistant',
    text: 'I can run shell commands, inspect gateway health, and help you debug Tailscale routing.',
    timestamp: Date.now() - 86_400_000 + 15_000,
  },
  {
    id: 'preview-assistant-stream',
    role: 'assistant',
    text: 'Pulling live gateway metrics',
    timestamp: Date.now(),
    streaming: true,
  },
];