import Constants from 'expo-constants';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';

import { GatewayDiscoveryScanner } from '@/lib/discovery/scanner';
import { buildGatewayCandidates, friendlyPcName, normalizePcAddress } from '@/lib/gateway/candidates';
import { OpenClawGatewayClient } from '@/lib/gateway/client';
import { createMessageId, extractMessageText, historyToChatMessages } from '@/lib/gateway/messages';
import { categorizeProbeError, probeGatewayCandidates, probeGatewayUrl, probeHighPriorityCandidates } from '@/lib/gateway/probe';
import { executeGatewaySlashCommand, isSlashCommandInput } from '@/lib/gateway/slash-commands';
import { GATEWAY_COMMANDS } from '@/lib/gateway/dashboard';
import type { GatewayActionPreview } from '@/lib/gateway/types';
import {
  createGatewayProfile,
  loadActiveGatewayId,
  loadGateways,
  removeGateway,
  saveActiveGatewayId,
  upsertGateway,
} from '@/lib/gateway/storage';
import type {
  ChatEventPayload,
  ChatMessage,
  ConnectionStatus,
  GatewayHelloOk,
  GatewayProfile,
  PairingDetails,
} from '@/lib/gateway/types';
import { loadAppSettings, saveAppSettings, type AppSettings } from '@/lib/settings/app-settings';
import {
  appendTranscript,
  createTranscriptId,
  loadTranscripts,
  updateTranscript,
} from '@/lib/gateway/transcript';
import type { CommandTranscriptEntry, GatewayCapabilitySnapshot } from '@/lib/gateway/types';
import { buildCapabilitySnapshot } from '@/lib/gateway/dashboard';

export type ConnectionPhase =
  | 'idle'
  | 'booting'
  | 'searching'
  | 'connecting'
  | 'connected'
  | 'pairing'
  | 'failed'
  | 'onboarding';

type GatewayContextValue = {
  gateways: GatewayProfile[];
  activeGateway: GatewayProfile | null;
  activeHello: GatewayHelloOk | null;
  status: ConnectionStatus;
  statusDetail: string;
  connectionPhase: ConnectionPhase;
  probeMessage: string;
  messages: ChatMessage[];
  isSending: boolean;
  isCommandRunning: boolean;
  runningCommandLabel: string | null;
  lastError: string | null;
  deviceId: string | null;
  pairingDetails: PairingDetails | null;
  settings: AppSettings;
  isBootstrapped: boolean;
  needsOnboarding: boolean;
  refreshGateways: () => Promise<void>;
  addGateway: (input: {
    name: string;
    url: string;
    token?: string;
    bootstrapToken?: string;
    tlsFingerprint?: string;
    sessionKey?: string;
    agentId?: string;
    discoverySource?: GatewayProfile['discoverySource'];
  }) => Promise<GatewayProfile>;
  gatewayRequest: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;
  runAgentCommand: (command: string) => Promise<void>;
  deleteGateway: (id: string) => Promise<void>;
  connectGateway: (gateway: GatewayProfile) => Promise<void>;
  disconnectGateway: () => void;
  sendMessage: (text: string) => Promise<void>;
  sendChatInput: (text: string) => Promise<void>;
  stopStreaming: () => Promise<void>;
  reloadHistory: () => Promise<void>;
  setupFromPcAddress: (pcAddress: string, token?: string) => Promise<boolean>;
  retryAutoConnect: () => Promise<void>;
  completeOnboarding: () => Promise<void>;
  setAutoConnect: (enabled: boolean) => Promise<void>;
  transcripts: CommandTranscriptEntry[];
  retryCommand: (entry: Partial<CommandTranscriptEntry> & { input: string }) => void;
  cancelCommand: (id: string) => void;
  capabilitySnapshot: import('@/lib/gateway/types').GatewayCapabilitySnapshot;
  refreshCapabilities: () => void;
  pendingConfirmation: import('@/lib/gateway/types').GatewayActionPreview | null;
  confirmPendingAction: () => void;
  cancelPendingConfirmation: () => void;
  modelPicker: {
    visible: boolean;
    mode: 'default' | 'fallbacks' | 'agent';
    agentId?: string;
  };
  openModelPicker: (mode: 'default' | 'fallbacks' | 'agent', agentId?: string) => void;
  closeModelPicker: () => void;
  selectModel: (modelId: string) => void;
  modelCatalog: any[];
  sessionSelector: { visible: boolean };
  openSessionSelector: () => void;
  closeSessionSelector: () => void;
  selectSession: (sessionId: string) => void;
  sessionList: any[];
  currentSessionId?: string;
};

const GatewayContext = createContext<GatewayContextValue | null>(null);

let sharedDiscoveryScanner: GatewayDiscoveryScanner | null = null;

function getDiscoveryScanner() {
  if (!sharedDiscoveryScanner) sharedDiscoveryScanner = new GatewayDiscoveryScanner();
  return sharedDiscoveryScanner;
}

type SetupCredentials = {
  token?: string;
  bootstrapToken?: string;
};

function normalizeSetupTokenInput(input?: string): SetupCredentials {
  const trimmed = input?.trim();
  if (!trimmed) return {};

  const tokenKeys = ['token', 'setupToken', 'authToken', 'gatewayToken'];
  const bootstrapTokenKeys = ['bootstrapToken'];
  const fromObject = readTokenFromObject(readJsonObject(trimmed), tokenKeys);
  if (fromObject) return { token: fromObject };
  const fromObjectBootstrap = readTokenFromObject(readJsonObject(trimmed), bootstrapTokenKeys);
  if (fromObjectBootstrap) return { bootstrapToken: fromObjectBootstrap };
  const fromObjectCode = readTokenFromSetupCodeField(readJsonObject(trimmed), tokenKeys, bootstrapTokenKeys);
  if (fromObjectCode) return fromObjectCode;

  const decodedSetupCode = decodeSetupCode(trimmed);
  const fromSetupCode = readTokenFromObject(decodedSetupCode, tokenKeys);
  if (fromSetupCode) return { token: fromSetupCode };
  const fromSetupBootstrap = readTokenFromObject(decodedSetupCode, bootstrapTokenKeys);
  if (fromSetupBootstrap) return { bootstrapToken: fromSetupBootstrap };

  const candidates = [trimmed];
  const queryStart = trimmed.indexOf('?');
  const hashStart = trimmed.indexOf('#');
  if (queryStart >= 0) candidates.push(trimmed.slice(queryStart));
  if (hashStart >= 0) candidates.push(trimmed.slice(hashStart + 1));

  for (const candidate of candidates) {
    try {
      const url = candidate.includes('://') ? new URL(candidate) : null;
      const searchParams = url ? [url.searchParams, new URLSearchParams(url.hash.replace(/^#/, ''))] : [new URLSearchParams(candidate.replace(/^[?#]/, ''))];
      for (const params of searchParams) {
        for (const key of tokenKeys) {
          const value = params.get(key)?.trim();
          if (value) return { token: value };
        }

        const bootstrapToken = params.get('bootstrapToken')?.trim();
        if (bootstrapToken) return { bootstrapToken };

        const code = params.get('code')?.trim() ?? params.get('setupCode')?.trim();
        if (code) {
          const fromCode = readTokenFromObject(decodeSetupCode(code), tokenKeys);
          if (fromCode) return { token: fromCode };
          const bootstrapFromCode = readTokenFromObject(decodeSetupCode(code), bootstrapTokenKeys);
          if (bootstrapFromCode) return { bootstrapToken: bootstrapFromCode };
          return { token: code };
        }
      }
    } catch {
      // Fall through to the raw token path.
    }
  }

  return { token: trimmed };
}

function readJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function readTokenFromObject(
  value: Record<string, unknown> | undefined,
  tokenKeys: string[],
): string | undefined {
  if (!value) return undefined;
  for (const key of tokenKeys) {
    const token = value[key];
    if (typeof token === 'string' && token.trim()) return token.trim();
  }
  return undefined;
}

function readTokenFromSetupCodeField(
  value: Record<string, unknown> | undefined,
  tokenKeys: string[],
  bootstrapTokenKeys: string[],
): SetupCredentials | undefined {
  if (!value) return undefined;
  const code = value.code ?? value.setupCode;
  if (typeof code !== 'string' || !code.trim()) return undefined;
  const decoded = decodeSetupCode(code);
  const token = readTokenFromObject(decoded, tokenKeys);
  if (token) return { token };
  const bootstrapToken = readTokenFromObject(decoded, bootstrapTokenKeys);
  if (bootstrapToken) return { bootstrapToken };
  return { token: code.trim() };
}

function decodeSetupCode(value: string): Record<string, unknown> | undefined {
  const compact = value.trim().replace(/^openclaw:\/\//i, '');
  if (!compact) return undefined;

  try {
    const base64 = compact.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const decoded =
      typeof globalThis.atob === 'function'
        ? globalThis.atob(padded)
        : decodeBase64Ascii(padded);
    return readJsonObject(decoded);
  } catch {
    return undefined;
  }
}

function decodeBase64Ascii(value: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let buffer = 0;
  let bits = 0;
  let output = '';

  for (const char of value.replace(/=+$/, '')) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error('Invalid setup code');
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output += String.fromCharCode((buffer >> bits) & 0xff);
    }
  }

  return output;
}

function readCommandLabel(input: string): string {
  const [command, subcommand] = input.trim().split(/\s+/, 2);
  return [command, subcommand && !subcommand.startsWith('{') ? subcommand : undefined].filter(Boolean).join(' ');
}

function findMatchingCommand(input: string) {
  const tokens = input.trim().toLowerCase().split(/\s+/);
  for (let depth = tokens.length; depth >= 1; depth -= 1) {
    const prefix = tokens.slice(0, depth).join(' ');
    const match = GATEWAY_COMMANDS.find((command) => {
      const slashes = [command.slash, ...(command.aliases ?? [])]
        .filter(Boolean)
        .map((item) => item!.toLowerCase());
      return slashes.includes(prefix);
    });
    if (match) return match;
  }
  return undefined;
}

function configuredGatewayHosts(): string[] {
  const hosts = new Set<string>();
  const push = (value: unknown) => {
    if (typeof value !== 'string') return;
    for (const host of value.split(',')) {
      const trimmed = host.trim();
      if (trimmed) hosts.add(trimmed);
    }
  };

  push(process.env.EXPO_PUBLIC_OPENCLAW_GATEWAY_HOSTS);
  push(process.env.EXPO_PUBLIC_OPENCLAW_GATEWAY_HOST);

  const extra = Constants.expoConfig?.extra as Record<string, unknown> | undefined;
  const extraHosts = extra?.openClawGatewayHosts;
  if (Array.isArray(extraHosts)) {
    for (const host of extraHosts) push(host);
  } else {
    push(extraHosts);
  }

  return [...hosts];
}

async function discoverForProbe(timeoutMs = 4200): Promise<import('@/lib/discovery/types').DiscoveredGateway[]> {
  const scanner = getDiscoveryScanner();
  return new Promise((resolve) => {
    let latest: import('@/lib/discovery/types').DiscoveredGateway[] = [];
    const unsubscribe = scanner.subscribe((state) => {
      latest = state.gateways;
    });
    scanner.start();
    setTimeout(() => {
      unsubscribe();
      resolve(latest);
    }, timeoutMs);
  });
}

export function GatewayProvider({ children }: { children: React.ReactNode }) {
  const [gateways, setGateways] = useState<GatewayProfile[]>([]);
  const [activeGateway, setActiveGateway] = useState<GatewayProfile | null>(null);
  const activeGatewayRef = useRef<GatewayProfile | null>(null);
  useEffect(() => {
    activeGatewayRef.current = activeGateway;
  }, [activeGateway]);
  const [activeHello, setActiveHello] = useState<GatewayHelloOk | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [statusDetail, setStatusDetail] = useState('');
  const [connectionPhase, setConnectionPhase] = useState<ConnectionPhase>('booting');
  const connectionPhaseRef = useRef<ConnectionPhase>('booting');
  useEffect(() => {
    connectionPhaseRef.current = connectionPhase;
  }, [connectionPhase]);
  const [probeMessage, setProbeMessage] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [isCommandRunning, setIsCommandRunning] = useState(false);
  const [runningCommandLabel, setRunningCommandLabel] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [pairingDetails, setPairingDetails] = useState<PairingDetails | null>(null);
  const [settings, setSettings] = useState<AppSettings>({ autoConnect: true, onboardingComplete: false });
  const settingsRef = useRef<AppSettings>({ autoConnect: true, onboardingComplete: false });
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);
  const [isBootstrapped, setIsBootstrapped] = useState(false);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const [transcripts, setTranscripts] = useState<CommandTranscriptEntry[]>([]);
  const [capabilitySnapshot, setCapabilitySnapshot] = useState<GatewayCapabilitySnapshot>(() => ({
    checkedAt: Date.now(),
    status: 'offline',
    groups: [],
    methods: {},
    scopes: [],
  }));
  const [pendingConfirmation, setPendingConfirmation] = useState<import('@/lib/gateway/types').GatewayActionPreview | null>(null);
  const [modelPicker, setModelPicker] = useState<{
    visible: boolean;
    mode: 'default' | 'fallbacks' | 'agent';
    agentId?: string;
  }>({ visible: false, mode: 'default' });
  const [modelCatalog, setModelCatalog] = useState<any[]>([]);
  const [sessionList, setSessionList] = useState<any[]>([]);
  const [sessionSelector, setSessionSelector] = useState<{ visible: boolean }>({ visible: false });
  const [currentSessionId, setCurrentSessionId] = useState<string | undefined>(undefined);
  const confirmationBypassRef = useRef(false);

  const clientRef = useRef<OpenClawGatewayClient | null>(null);
  const activeRunIdRef = useRef<string | null>(null);
  const sessionIdRef = useRef<string | undefined>(undefined);
  const bootstrapStartedRef = useRef(false);
  const autoConnectInFlightRef = useRef(false);
  const autoRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleAutoRetryRef = useRef<(delayMs?: number) => void>(() => undefined);
  const commandStartTimeRef = useRef<number>(0);

  const handleChatEvent = useCallback((payload: ChatEventPayload) => {
    if (!activeGateway || payload.sessionKey !== activeGateway.sessionKey) return;

    const text = extractMessageText(payload.message?.content);
    const runId = payload.runId ?? 'stream';

    if (payload.state === 'delta' && text) {
      setMessages((prev) => {
        const index = prev.findIndex((item) => item.id === `run-${runId}`);
        const nextMessage: ChatMessage = {
          id: `run-${runId}`,
          role: 'assistant',
          text,
          streaming: true,
          timestamp: payload.message?.timestamp,
        };
        if (index >= 0) {
          const copy = [...prev];
          copy[index] = nextMessage;
          return copy;
        }
        return [...prev, nextMessage];
      });
      return;
    }

    if (payload.state === 'final') {
      if (!text) {
        setMessages((prev) => prev.filter((item) => item.id !== `run-${runId}`));
      } else {
        setMessages((prev) => {
          const index = prev.findIndex((item) => item.id === `run-${runId}`);
          const nextMessage: ChatMessage = {
            id: `run-${runId}`,
            role: 'assistant',
            text,
            timestamp: payload.message?.timestamp,
          };
          if (index >= 0) {
            const copy = [...prev];
            copy[index] = nextMessage;
            return copy;
          }
          return [...prev, nextMessage];
        });
      }
      setIsSending(false);
      activeRunIdRef.current = null;
      return;
    }

    if (payload.state === 'error') {
      const errorText = payload.errorMessage ?? text ?? 'Agent run failed';
      setMessages((prev) => [
        ...prev.filter((item) => item.id !== `run-${runId}`),
        {
          id: createMessageId('error'),
          role: 'assistant',
          text: errorText.startsWith('Error:') ? errorText : `Error: ${errorText}`,
        },
      ]);
      setIsSending(false);
      activeRunIdRef.current = null;
    }
  }, [activeGateway]);

  const reloadHistoryFor = useCallback(async (gateway: GatewayProfile) => {
    const client = clientRef.current;
    if (!client) return;

    try {
      const history = (await client.request<{ messages?: unknown[]; sessionId?: string }>(
        'chat.history',
        {
          sessionKey: gateway.sessionKey,
          agentId: gateway.agentId,
          limit: 80,
        },
      )) as { messages?: unknown[]; sessionId?: string };

      sessionIdRef.current = history.sessionId;
      setCurrentSessionId(history.sessionId);

      const gatewayMessages = historyToChatMessages(history.messages ?? []);

      // Load and merge local command transcripts
      const localTrans = await loadTranscripts(gateway.id, gateway.sessionKey);
      setTranscripts(localTrans);

      const commandMessages = localTrans.map((t) => ({
        id: t.id,
        role: 'assistant' as const,
        text: t.summary,
        timestamp: t.createdAt,
        command: {
          input: t.input,
          title: t.title,
          raw: t.raw,
          status: t.status === 'cancelled' ? 'error' : t.status,
          ephemeral: t.ephemeral,
          durationMs: t.durationMs,
        },
      }));

      // Merge: put gateway history first, then append local command results that are not already represented
      const merged = [...gatewayMessages];
      for (const cm of commandMessages) {
        if (!merged.some((m) => m.id === cm.id)) {
          merged.push(cm);
        }
      }

      setMessages(merged);
      setLastError(null);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const attachClient = useCallback(
    (gateway: GatewayProfile) => {
      const existing = clientRef.current;
      const existingStatus = existing?.connectionStatus;
      if (
        existing &&
        activeGatewayRef.current?.id === gateway.id &&
        (existingStatus === 'connected' ||
          existingStatus === 'connecting' ||
          existingStatus === 'reconnecting' ||
          existingStatus === 'pairing')
      ) {
        return;
      }
      clientRef.current?.disconnect();
      const client = new OpenClawGatewayClient(gateway, {
        onStatus: (nextStatus, detail) => {
          setStatus(nextStatus);
          setStatusDetail(detail ?? '');
          if (nextStatus === 'connected') {
            if (autoRetryTimerRef.current) {
              clearTimeout(autoRetryTimerRef.current);
              autoRetryTimerRef.current = null;
            }
            setConnectionPhase('connected');
            setProbeMessage('');
            setLastError(null);
            setPairingDetails(null);
          } else if (nextStatus === 'pairing') {
            setConnectionPhase('pairing');
          } else if (nextStatus === 'connecting' || nextStatus === 'reconnecting') {
            setConnectionPhase('connecting');
            setLastError(null);
          } else if (nextStatus === 'disconnected') {
            setConnectionPhase((phase) =>
              phase === 'pairing'
                ? 'pairing'
                : phase === 'searching' || phase === 'connecting' || phase === 'connected'
                  ? 'failed'
                  : phase,
            );
            // Automatic recovery: if we had an active gateway, fall back to full search on next retry
            if (activeGatewayRef.current) {
              // schedule background retry for better automatic UX when disconnected unexpectedly
              scheduleAutoRetryRef.current(12000);
            }
          }
        },
        onHello: (hello) => {
          setActiveHello(hello);
          if ((gateway.token || gateway.bootstrapToken) && hello.auth?.deviceToken) {
            const pairedGateway = {
              ...gateway,
              token: undefined,
              bootstrapToken: undefined,
            };
            void upsertGateway(pairedGateway).then((next) => {
              setGateways(next);
              setActiveGateway((current) => (current?.id === pairedGateway.id ? pairedGateway : current));
            });
          }
          void reloadHistoryFor(gateway);
        },
        onPairingRequired: (details) => setPairingDetails(details),
        onChatEvent: handleChatEvent,
        onError: (message) => setLastError(message),
      });
      clientRef.current = client;
      setConnectionPhase('connecting');
      client.connect();
    },
    [handleChatEvent, reloadHistoryFor],
  );

  const connectGateway = useCallback(
    async (gateway: GatewayProfile) => {
      setActiveGateway(gateway);
      setActiveHello(null);
      setMessages([]);
      setLastError(null);
      setPairingDetails(null);
      setIsSending(false);
      activeRunIdRef.current = null;
      await saveActiveGatewayId(gateway.id);
      attachClient(gateway);
    },
    [attachClient],
  );

  const resolveGatewayForUrl = useCallback(
    async (
      url: string,
      appSettings: AppSettings,
      currentGateways: GatewayProfile[],
      discovered: import('@/lib/discovery/types').DiscoveredGateway[],
      token?: string,
    ) => {
      const existing = currentGateways.find((item) => item.url === url);
      const credentials = normalizeSetupTokenInput(token);
      if (existing) {
        const hasNewCredentials = Boolean(credentials.token || credentials.bootstrapToken);
        if (
          !hasNewCredentials ||
          (existing.token === credentials.token && existing.bootstrapToken === credentials.bootstrapToken)
        ) return existing;
        const nextProfile = {
          ...existing,
          token: credentials.token ?? existing.token,
          bootstrapToken: credentials.bootstrapToken ?? existing.bootstrapToken,
        };
        const next = await upsertGateway(nextProfile);
        setGateways(next);
        return nextProfile;
      }

      const discoveredMatch = discovered.find((item) => item.url === url);
      const profile = createGatewayProfile({
        name: appSettings.pcName ?? discoveredMatch?.name ?? friendlyPcName(appSettings.tailscaleHost ?? 'PC'),
        url,
        token: credentials.token,
        bootstrapToken: credentials.bootstrapToken,
        tlsFingerprint: discoveredMatch?.tlsFingerprint,
        discoverySource:
          url.includes('.ts.net') || url.startsWith('wss://')
            ? 'tailscale'
            : discoveredMatch
              ? 'local'
              : 'manual',
      });
      const next = await upsertGateway(profile);
      setGateways(next);
      return profile;
    },
    [],
  );

  const runAutoConnect = useCallback(
    async (appSettings: AppSettings, currentGateways: GatewayProfile[], activeId: string | null) => {
      if (autoConnectInFlightRef.current) return;
      if (autoRetryTimerRef.current) {
        clearTimeout(autoRetryTimerRef.current);
        autoRetryTimerRef.current = null;
      }
      const currentPhase = connectionPhaseRef.current;
      if (currentPhase === 'connected') {
        autoConnectInFlightRef.current = false;
        return;
      }
      autoConnectInFlightRef.current = true;
      setConnectionPhase('searching');
      setProbeMessage('Looking for your gateway…');
      setLastError(null);

      try {
        const discovered = await discoverForProbe();

        if (activeId) {
          const saved = currentGateways.find((item) => item.id === activeId);
          if (saved) {
            setProbeMessage(`Reconnecting to ${saved.name}…`);
            const savedProbe = await probeGatewayUrl(saved.url, 3500);
            if (savedProbe.ok) {
              if (autoRetryTimerRef.current) {
                clearTimeout(autoRetryTimerRef.current);
                autoRetryTimerRef.current = null;
              }
              await saveAppSettings({ lastSuccessfulUrl: saved.url });
              setSettings((prev) => ({ ...prev, lastSuccessfulUrl: saved.url }));
              await connectGateway(saved);
              return;
            }
          }
        }

        // Build high-priority list for fast parallel probe: last success + fresh discovered (most automatic paths)
        const highPriorityUrls: string[] = [];
        if (Platform.OS === 'web') {
          for (const localUrl of ['ws://127.0.0.1:18789', 'ws://localhost:18789']) {
            if (!highPriorityUrls.includes(localUrl)) highPriorityUrls.push(localUrl);
          }
        }
        const lastUrl = appSettings.lastSuccessfulUrl;
        if (lastUrl && !highPriorityUrls.includes(lastUrl)) highPriorityUrls.push(lastUrl);
        for (const d of discovered) {
          if (!highPriorityUrls.includes(d.url)) highPriorityUrls.push(d.url);
        }

        let probeResult: Awaited<ReturnType<typeof probeHighPriorityCandidates>> = null;

        if (highPriorityUrls.length > 0) {
          probeResult = await probeHighPriorityCandidates(highPriorityUrls, setProbeMessage, 3500);
        }

        if (!probeResult?.ok) {
          // Fall back to full candidate list (includes saved, tailscale, configured, fallbacks) with sequential
          const candidates = buildGatewayCandidates({
            tailscaleHost: appSettings.tailscaleHost,
            configuredHosts: configuredGatewayHosts(),
            savedUrls: currentGateways.map((item) => item.url),
            discovered,
            lastSuccessfulUrl: appSettings.lastSuccessfulUrl,
            platform: Platform.OS,
          });

          if (candidates.length === 0) {
            setConnectionPhase('failed');
            setProbeMessage('Add your PC Tailscale address to connect.');
            scheduleAutoRetryRef.current(30000);
            return;
          }

          probeResult = await probeGatewayCandidates(candidates, setProbeMessage, 3500);
        }

        if (!probeResult?.ok) {
          setConnectionPhase('failed');
          const hint = categorizeProbeError(probeResult) || (probeResult?.error ? `${probeResult.error}. ` : '');
          setProbeMessage(hint || 'Check that your gateway is running and reachable (Tailscale or local network).');
          scheduleAutoRetryRef.current(20000);
          return;
        }

        const gateway = await resolveGatewayForUrl(
          probeResult.url,
          appSettings,
          currentGateways,
          discovered,
        );
        const nextSettings = await saveAppSettings({ lastSuccessfulUrl: probeResult.url });
        setSettings(nextSettings);
        await connectGateway(gateway);
      } finally {
        autoConnectInFlightRef.current = false;
      }
    },
    [connectGateway, resolveGatewayForUrl],
  );

  const refreshGateways = useCallback(async () => {
    const loaded = await loadGateways();
    setGateways(loaded);
    const activeId = await loadActiveGatewayId();
    if (!activeId) return;
    const active = loaded.find((item) => item.id === activeId) ?? null;
    setActiveGateway(active);
  }, []);

  const bootstrap = useCallback(async () => {
    try {
      const [loadedSettings, loadedGateways, activeId] = await Promise.all([
        loadAppSettings(),
        loadGateways(),
        loadActiveGatewayId(),
      ]);

      setSettings(loadedSettings);
      setGateways(loadedGateways);

      const active = activeId ? (loadedGateways.find((item) => item.id === activeId) ?? null) : null;
      setActiveGateway(active);

      const onboardingNeeded =
        !loadedSettings.onboardingComplete && loadedGateways.length === 0 && !loadedSettings.tailscaleHost;
      setIsBootstrapped(true);

      if (!loadedSettings.autoConnect) {
        setNeedsOnboarding(onboardingNeeded);
        setConnectionPhase('idle');
        return;
      }

      setNeedsOnboarding(false);

      void runAutoConnect(loadedSettings, loadedGateways, activeId).catch((error) => {
        setConnectionPhase('failed');
        setNeedsOnboarding(onboardingNeeded);
        setProbeMessage('Auto-connect failed. Tap retry or check your gateway address.');
        setLastError(error instanceof Error ? error.message : String(error));
        scheduleAutoRetryRef.current(18000);
      });
    } catch (error) {
      setIsBootstrapped(true);
      setConnectionPhase('failed');
      setProbeMessage('Could not load saved gateway settings. Check app permissions and retry.');
      setLastError(error instanceof Error ? error.message : String(error));
      scheduleAutoRetryRef.current(30000);
    }
  }, [runAutoConnect]);

  useEffect(() => {
    if (bootstrapStartedRef.current) return;
    bootstrapStartedRef.current = true;
    void bootstrap();
    void import('@/lib/gateway/device-identity').then(({ loadOrCreateDeviceIdentity }) =>
      loadOrCreateDeviceIdentity().then((identity) => setDeviceId(identity.deviceId)),
    );
    return () => clientRef.current?.disconnect();
  }, [bootstrap]);

  useEffect(() => {
    if (status !== 'pairing' || !activeGateway) return;
    const timer = setInterval(() => {
      const client = clientRef.current;
      const liveStatus = client?.connectionStatus;
      if (
        liveStatus === 'connected' ||
        liveStatus === 'connecting' ||
        liveStatus === 'reconnecting'
      ) {
        return;
      }
      attachClient(activeGateway);
    }, 6000);
    return () => clearInterval(timer);
  }, [status, activeGateway, attachClient]);

  // Phase 2: Live snapshot recompute (bounded, no persistent sockets for inactive)
  useEffect(() => {
    const snap = buildCapabilitySnapshot(status, activeHello);
    setCapabilitySnapshot(snap);
  }, [status, activeHello]);

  const addGateway = useCallback(
    async (input: {
      name: string;
      url: string;
      token?: string;
      bootstrapToken?: string;
      tlsFingerprint?: string;
      sessionKey?: string;
      agentId?: string;
      discoverySource?: GatewayProfile['discoverySource'];
    }) => {
      const credentials = normalizeSetupTokenInput(input.token);
      const profile = createGatewayProfile({
        ...input,
        token: credentials.token,
        bootstrapToken: input.bootstrapToken ?? credentials.bootstrapToken,
      });
      const next = await upsertGateway(profile);
      setGateways(next);
      return profile;
    },
    [],
  );

  const gatewayRequest = useCallback(
    async <T,>(method: string, params: Record<string, unknown> = {}) => {
      const client = clientRef.current;
      if (!client || status !== 'connected') throw new Error('Gateway not connected');
      return client.request<T>(method, params);
    },
    [status],
  );

  const runAgentCommand = useCallback(
    async (command: string) => {
      const gateway = activeGateway;
      const client = clientRef.current;
      const trimmed = command.trim();
      if (!trimmed || !gateway || !client || status !== 'connected') {
        throw new Error('Connect to a gateway first');
      }

      const runId = createMessageId('cmd');
      await client.request('chat.send', {
        sessionKey: gateway.sessionKey,
        agentId: gateway.agentId,
        sessionId: sessionIdRef.current,
        message: trimmed,
        idempotencyKey: runId,
        timeoutMs: 120000,
      });
    },
    [activeGateway, status],
  );

  const appendLocalMessage = useCallback((role: ChatMessage['role'], text: string, command?: ChatMessage['command']) => {
    const id = createMessageId(role === 'user' ? 'user' : 'cmd');
    const ts = Date.now();

    const msg: ChatMessage = {
      id,
      role,
      text,
      timestamp: ts,
      command,
    };

    setMessages((prev) => [...prev, msg]);

    // Also persist as transcript when it's a command entry
    if (command?.input && activeGateway) {
      const entry: CommandTranscriptEntry = {
        id,
        gatewayId: activeGateway.id,
        sessionKey: activeGateway.sessionKey,
        sessionId: sessionIdRef.current,
        input: command.input,
        title: command.title ?? readCommandLabel(command.input),
        status: (command.status as any) ?? 'running',
        summary: text,
        raw: command.raw,
        createdAt: ts,
        ephemeral: command.ephemeral ?? true,
      };
      // Fire and forget persistence
      void appendTranscript(activeGateway.id, activeGateway.sessionKey, entry).then((updated) => {
        setTranscripts(updated);
      });
    }

    return id;
  }, [activeGateway]);

  const updateLocalMessage = useCallback((id: string, patch: Partial<ChatMessage>) => {
    setMessages((prev) =>
      prev.map((message) =>
        message.id === id
          ? {
              ...message,
              ...patch,
              command: patch.command ? { ...message.command, ...patch.command } : message.command,
            }
          : message,
      ),
    );

    // Persist transcript updates when active
    if (activeGateway) {
      const statusPatch: Partial<CommandTranscriptEntry> = {};
      if (patch.command?.status) statusPatch.status = patch.command.status as any;
      if (patch.text) statusPatch.summary = patch.text;
      if (patch.command?.raw) statusPatch.raw = patch.command.raw;
      if (Object.keys(statusPatch).length > 0) {
        if (commandStartTimeRef.current) {
          statusPatch.durationMs = Date.now() - commandStartTimeRef.current;
        }
        void updateTranscript(activeGateway.id, activeGateway.sessionKey, id, statusPatch).then((updated) => {
          setTranscripts(updated);
        });
      }
    }
  }, [activeGateway]);

  const deleteGateway = useCallback(async (id: string) => {
    const next = await removeGateway(id);
    setGateways(next);
    if (activeGateway?.id === id) {
      clientRef.current?.disconnect();
      setActiveGateway(null);
      setActiveHello(null);
      setMessages([]);
      setPairingDetails(null);
      await saveActiveGatewayId(null);
      // If autoConnect and other gateways remain, automatically search for next best
      if (settings.autoConnect && next.length > 0) {
        setConnectionPhase('searching');
        setProbeMessage('Searching for another gateway…');
        void runAutoConnect(settings, next, null);
      } else {
        setConnectionPhase('idle');
      }
    }
  }, [activeGateway, settings, runAutoConnect]);

  const disconnectGateway = useCallback(() => {
    clientRef.current?.disconnect();
    setActiveGateway(null);
    setActiveHello(null);
    setMessages([]);
    setIsSending(false);
    setPairingDetails(null);
    setConnectionPhase('idle');
    void saveActiveGatewayId(null);
  }, []);

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      const gateway = activeGateway;
      const client = clientRef.current;
      if (!trimmed || !gateway || !client || isSending) return;

      const userMessage: ChatMessage = {
        id: createMessageId('user'),
        role: 'user',
        text: trimmed,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, userMessage]);
      setIsSending(true);
      setLastError(null);

      const runId = createMessageId('run');
      activeRunIdRef.current = runId;

      try {
        await client.request('chat.send', {
          sessionKey: gateway.sessionKey,
          agentId: gateway.agentId,
          sessionId: sessionIdRef.current,
          message: trimmed,
          idempotencyKey: runId,
          timeoutMs: 120000,
        });
      } catch (error) {
        setIsSending(false);
        activeRunIdRef.current = null;
        setLastError(error instanceof Error ? error.message : String(error));
      }
    },
    [activeGateway, isSending],
  );

  const openModelPicker = useCallback(async (mode: 'default' | 'fallbacks' | 'agent', agentId?: string) => {
    try {
      const catalog = await gatewayRequest('models.list', {});
      const items = (catalog as any)?.models || (catalog as any)?.items || [];
      setModelCatalog(items);
    } catch {
      // Keep picker usable with any cached catalog.
    }
    setModelPicker({ visible: true, mode, agentId });
  }, [gatewayRequest]);

  const closeModelPicker = useCallback(() => {
    setModelPicker({ visible: false, mode: 'default' });
  }, []);

  const openSessionSelector = useCallback(async () => {
    try {
      const res = await gatewayRequest('sessions.list', { limit: 20 });
      const items = (res as any)?.sessions || (res as any)?.items || [];
      setSessionList(items);
    } catch {
      // Keep selector usable with any cached list.
    }
    setSessionSelector({ visible: true });
  }, [gatewayRequest]);

  const closeSessionSelector = useCallback(() => {
    setSessionSelector({ visible: false });
  }, []);

  const stopStreaming = useCallback(async () => {
    const gateway = activeGateway;
    const client = clientRef.current;
    const runId = activeRunIdRef.current;

    setIsSending(false);
    activeRunIdRef.current = null;
    setMessages((prev) => prev.filter((item) => !item.streaming && !(runId ? item.id === `run-${runId}` : false)));

    if (!gateway || !client || status !== 'connected') return;

    try {
      const params: Record<string, unknown> = {};
      if (sessionIdRef.current) params.sessionId = sessionIdRef.current;
      await client.request('session.abort', params);
    } catch {
      try {
        await runAgentCommand('/stop');
      } catch {
        // Best-effort stop; history reload below reconciles UI state.
      }
    }

    await reloadHistoryFor(gateway);
  }, [activeGateway, reloadHistoryFor, runAgentCommand, status]);

  const sendChatInput = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      if (!isSlashCommandInput(trimmed)) {
        await sendMessage(trimmed);
        return;
      }

      if (isCommandRunning) return;

      appendLocalMessage('user', trimmed);
      const commandLabel = readCommandLabel(trimmed);
      const matchingCmd = findMatchingCommand(trimmed);
      const hasConfirmFlag = trimmed.includes('--confirm');
      const lower = trimmed.toLowerCase();
      const isSetAgent = lower.startsWith('/model set-agent');
      const isModelSet = !isSetAgent && (lower === '/model set' || lower.startsWith('/model set '));
      const isFallbacks = lower === '/model fallbacks' || lower.startsWith('/model fallbacks ');
      const hasModelId =
        isModelSet || isFallbacks || isSetAgent ? trimmed.split(/\s+/).length > 2 : false;

      if ((isModelSet || isFallbacks || isSetAgent) && !hasModelId) {
        const mode = isSetAgent ? 'agent' : isFallbacks ? 'fallbacks' : 'default';
        const agentId = isSetAgent ? trimmed.split(/\s+/)[2] : undefined;
        void openModelPicker(mode, agentId);
        appendLocalMessage('assistant', `Opening model picker for ${commandLabel}...`, {
          input: trimmed,
          title: commandLabel,
          status: 'complete',
          ephemeral: true,
        });
        return;
      }

      if (lower === '/session list' || lower.startsWith('/session list ')) {
        void openSessionSelector();
        return;
      }

      const needsConfirmation =
        matchingCmd &&
        (matchingCmd.danger === 'write' || matchingCmd.danger === 'destructive') &&
        !hasConfirmFlag &&
        !confirmationBypassRef.current;

      if (needsConfirmation) {
        // For commands that support internal preview (e.g. /model set), call execute to get rich preview text
        let previewSummary = `This will perform a ${matchingCmd.danger} action on the gateway.`;
        let previewRaw: string | undefined;
        try {
          const resp = await executeGatewaySlashCommand(trimmed, {
            hello: activeHello,
            gatewayRequest,
            runAgentCommand,
          });
          previewSummary = resp.text || previewSummary;
          previewRaw = resp.raw;
        } catch (e) {
          // fallback to basic
        }

        const preview: GatewayActionPreview = {
          title: matchingCmd.label || commandLabel,
          summary: previewSummary,
          risk: matchingCmd.danger === 'destructive' ? 'high' : 'medium',
          applyCommand: trimmed,
          ...(previewRaw ? { diff: [{ label: 'Response', before: '', after: previewRaw }] } : {}),
        };
        setPendingConfirmation(preview);
        appendLocalMessage('assistant', `Preview ready for ${commandLabel}.`, {
          input: trimmed,
          title: commandLabel,
          status: 'complete',
          ephemeral: true,
          raw: previewRaw,
        });
        setIsCommandRunning(false);
        setRunningCommandLabel(null);
        return;
      }

      commandStartTimeRef.current = Date.now();
      const commandMessageId = appendLocalMessage('assistant', `Running ${commandLabel}...`, {
        input: trimmed,
        title: commandLabel,
        status: 'running',
        ephemeral: true,
      });
      setIsCommandRunning(true);
      setRunningCommandLabel(commandLabel);
      setLastError(null);
      try {
        const response = await executeGatewaySlashCommand(trimmed, {
          hello: activeHello,
          gatewayRequest,
          runAgentCommand,
        });
        const duration = Date.now() - commandStartTimeRef.current;
        updateLocalMessage(commandMessageId, {
          text: response.text,
          timestamp: Date.now(),
          command: {
            input: trimmed,
            title: response.title ?? commandLabel,
            raw: response.raw,
            status: 'complete',
            ephemeral: true,
          },
        });
        // Update transcript duration explicitly
        if (activeGateway) {
          void updateTranscript(activeGateway.id, activeGateway.sessionKey, commandMessageId, {
            summary: response.text,
            raw: response.raw,
            status: 'complete',
            durationMs: duration,
          }).then((t) => setTranscripts(t));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setLastError(message);
        const duration = Date.now() - commandStartTimeRef.current;
        updateLocalMessage(commandMessageId, {
          text: `Command failed: ${message}`,
          timestamp: Date.now(),
          command: {
            input: trimmed,
            title: commandLabel,
            status: 'error',
            ephemeral: true,
          },
        });
        if (activeGateway) {
          void updateTranscript(activeGateway.id, activeGateway.sessionKey, commandMessageId, {
            summary: `Command failed: ${message}`,
            status: 'error',
            durationMs: duration,
          }).then((t) => setTranscripts(t));
        }
      } finally {
        setIsCommandRunning(false);
        setRunningCommandLabel(null);
        commandStartTimeRef.current = 0;
      }
    },
    [
      activeGateway,
      activeHello,
      appendLocalMessage,
      gatewayRequest,
      isCommandRunning,
      openModelPicker,
      openSessionSelector,
      runAgentCommand,
      sendMessage,
      updateLocalMessage,
    ],
  );

  const reloadHistory = useCallback(async () => {
    if (!activeGateway) return;
    await reloadHistoryFor(activeGateway);
  }, [activeGateway, reloadHistoryFor]);

  const setupFromPcAddress = useCallback(
    async (pcAddress: string, token?: string) => {
      const host = normalizePcAddress(pcAddress);
      if (!host) throw new Error('Enter your PC Tailscale name or address');

      const pcName = friendlyPcName(host);
      const nextSettings = await saveAppSettings({
        tailscaleHost: host,
        pcName,
        onboardingComplete: true,
        autoConnect: true,
      });
      setSettings(nextSettings);
      setNeedsOnboarding(false);

      const discovered = await discoverForProbe(2500);

      const candidates = buildGatewayCandidates({
        tailscaleHost: host,
        configuredHosts: configuredGatewayHosts(),
        savedUrls: gateways.map((item) => item.url),
        discovered,
        lastSuccessfulUrl: nextSettings.lastSuccessfulUrl,
        platform: Platform.OS,
      });

      setConnectionPhase('searching');

      // Use high priority parallel on the top candidates built for this host (correct for explicit setup)
      let probeResult = await probeHighPriorityCandidates(candidates, setProbeMessage, 3000);

      if (!probeResult?.ok) {
        probeResult = await probeGatewayCandidates(candidates.slice(3), setProbeMessage, 3500);
      }
      if (!probeResult?.ok) {
        setConnectionPhase('failed');
        const hint = categorizeProbeError(probeResult) || (probeResult?.error ? `${probeResult.error}. ` : '');
        setProbeMessage(
          `${hint}Saved your PC, but could not reach the gateway. Make sure it is running and exposed over Tailscale or local network.`,
        );
        scheduleAutoRetryRef.current(20000);
        return false;
      }

      const gateway = await resolveGatewayForUrl(
        probeResult.url,
        nextSettings,
        gateways,
        discovered,
        token,
      );
      const saved = await saveAppSettings({ lastSuccessfulUrl: probeResult.url });
      setSettings(saved);
      if (autoRetryTimerRef.current) {
        clearTimeout(autoRetryTimerRef.current);
        autoRetryTimerRef.current = null;
      }
      await connectGateway(gateway);
      return true;
    },
    [connectGateway, gateways, resolveGatewayForUrl],
  );

  const retryAutoConnect = useCallback(async () => {
    if (autoRetryTimerRef.current) {
      clearTimeout(autoRetryTimerRef.current);
      autoRetryTimerRef.current = null;
    }
    // Load fresh to avoid stale closures from timers
    const [freshSettings, freshGateways, activeId] = await Promise.all([
      loadAppSettings(),
      loadGateways(),
      loadActiveGatewayId(),
    ]);
    const idToUse = activeId ?? (activeGateway?.id ?? null);
    await runAutoConnect(freshSettings, freshGateways, idToUse);
  }, [activeGateway?.id, runAutoConnect]);

  const scheduleAutoRetry = useCallback((delayMs = 15000) => {
    if (!settingsRef.current.autoConnect) return;
    if (autoRetryTimerRef.current) clearTimeout(autoRetryTimerRef.current);
    autoRetryTimerRef.current = setTimeout(() => {
      autoRetryTimerRef.current = null;
      const currentPhase = connectionPhaseRef.current;
      if (currentPhase === 'failed' || currentPhase === 'idle') {
        void retryAutoConnect();
      }
    }, delayMs);
  }, [retryAutoConnect]);
  scheduleAutoRetryRef.current = scheduleAutoRetry;

  const completeOnboarding = useCallback(async () => {
    const next = await saveAppSettings({ onboardingComplete: true });
    setSettings(next);
    setNeedsOnboarding(false);
    setConnectionPhase('idle');
  }, []);

  const setAutoConnect = useCallback(async (enabled: boolean) => {
    const next = await saveAppSettings({ autoConnect: enabled });
    setSettings(next);
  }, []);

  const retryCommand = useCallback((entry: Partial<CommandTranscriptEntry> & { input: string }) => {
    if (!entry.input) return;
    // Re-send the original command input
    void sendChatInput(entry.input);
  }, [sendChatInput]);

  const cancelCommand = useCallback((id: string) => {
    // Mark as cancelled and stop any running
    if (activeGateway) {
      void updateTranscript(activeGateway.id, activeGateway.sessionKey, id, {
        status: 'cancelled',
      }).then((t) => setTranscripts(t));
    }
    setIsCommandRunning(false);
    setRunningCommandLabel(null);
    // Trigger reload to clean streaming if any
    void reloadHistory();
  }, [activeGateway, reloadHistory]);

  const refreshCapabilities = useCallback(async () => {
    if (!activeGateway) return;
    try {
      // Bounded probe: try health if connected
      if (status === 'connected' && clientRef.current) {
        await gatewayRequest('health', {}).catch(() => {});
      }
      const snap = buildCapabilitySnapshot(status, activeHello);
      // Update checkedAt to now
      setCapabilitySnapshot({ ...snap, checkedAt: Date.now() });
    } catch {
      // ignore, snapshot will reflect current state
    }
  }, [activeGateway, status, activeHello, gatewayRequest]);

  const confirmPendingAction = useCallback(() => {
    if (!pendingConfirmation || !activeGateway) {
      setPendingConfirmation(null);
      return;
    }
    const apply = pendingConfirmation.applyCommand;
    setPendingConfirmation(null);
    confirmationBypassRef.current = true;
    // Execute the confirmed action (bypass sheet)
    void sendChatInput(apply + (apply.includes('--confirm') ? '' : ' --confirm')).finally(() => {
      confirmationBypassRef.current = false;
    });
  }, [pendingConfirmation, activeGateway, sendChatInput]);

  const cancelPendingConfirmation = useCallback(() => {
    if (pendingConfirmation) {
      // Optionally log as cancelled command
      const cmdId = createMessageId('cancel');
      appendLocalMessage('assistant', 'Action cancelled by user.', {
        input: pendingConfirmation.applyCommand,
        title: pendingConfirmation.title,
        status: 'error',
        ephemeral: true,
      });
    }
    setPendingConfirmation(null);
  }, [pendingConfirmation, appendLocalMessage]);

  const selectModel = useCallback((modelId: string) => {
    const { mode, agentId } = modelPicker;
    closeModelPicker();

    let cmd = '';
    if (mode === 'default') {
      cmd = `/model set ${modelId}`;
    } else if (mode === 'fallbacks') {
      cmd = `/model fallbacks ${modelId}`; // user can add more
    } else if (mode === 'agent' && agentId) {
      cmd = `/model set-agent ${agentId} ${modelId}`;
    }

    if (cmd) {
      void sendChatInput(cmd);  // will trigger preview + confirmation sheet
    }
  }, [modelPicker, closeModelPicker, sendChatInput]);

  const selectSession = useCallback((sessionId: string) => {
    closeSessionSelector();
    sessionIdRef.current = sessionId;
    if (activeGateway) {
      void reloadHistoryFor(activeGateway);
    }
    // Also send a command to attach if needed
    void sendChatInput(`/session get ${sessionId}`);
  }, [closeSessionSelector, activeGateway, reloadHistoryFor, sendChatInput]);

  const value = useMemo<GatewayContextValue>(
    () => ({
      gateways,
      activeGateway,
      activeHello,
      status,
      statusDetail,
      connectionPhase,
      probeMessage,
      messages,
      isSending,
      isCommandRunning,
      runningCommandLabel,
      lastError,
      deviceId,
      pairingDetails,
      settings,
      isBootstrapped,
      needsOnboarding,
      refreshGateways,
      addGateway,
      deleteGateway,
      connectGateway,
      disconnectGateway,
      sendMessage,
      sendChatInput,
      stopStreaming,
      reloadHistory,
      gatewayRequest,
      runAgentCommand,
      setupFromPcAddress,
      retryAutoConnect,
      completeOnboarding,
      setAutoConnect,
      transcripts,
      retryCommand,
      cancelCommand,
      capabilitySnapshot,
      refreshCapabilities,
      pendingConfirmation,
      confirmPendingAction,
      cancelPendingConfirmation,
      modelPicker,
      openModelPicker,
      closeModelPicker,
      selectModel,
      modelCatalog,
      sessionSelector,
      openSessionSelector,
      closeSessionSelector,
      selectSession,
      sessionList,
      currentSessionId,
    }),
    [
      gateways,
      activeGateway,
      activeHello,
      status,
      statusDetail,
      connectionPhase,
      probeMessage,
      messages,
      isSending,
      isCommandRunning,
      runningCommandLabel,
      lastError,
      deviceId,
      pairingDetails,
      settings,
      isBootstrapped,
      needsOnboarding,
      refreshGateways,
      addGateway,
      deleteGateway,
      connectGateway,
      disconnectGateway,
      sendMessage,
      sendChatInput,
      stopStreaming,
      reloadHistory,
      gatewayRequest,
      runAgentCommand,
      setupFromPcAddress,
      retryAutoConnect,
      completeOnboarding,
      setAutoConnect,
      transcripts,
      retryCommand,
      cancelCommand,
      capabilitySnapshot,
      refreshCapabilities,
      pendingConfirmation,
      confirmPendingAction,
      cancelPendingConfirmation,
      modelPicker,
      openModelPicker,
      closeModelPicker,
      selectModel,
      modelCatalog,
      sessionSelector,
      openSessionSelector,
      closeSessionSelector,
      selectSession,
      sessionList,
      currentSessionId,
    ],
  );

  return <GatewayContext.Provider value={value}>{children}</GatewayContext.Provider>;
}

export function useGateway() {
  const context = useContext(GatewayContext);
  if (!context) throw new Error('useGateway must be used within GatewayProvider');
  return context;
}
