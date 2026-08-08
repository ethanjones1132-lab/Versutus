import Constants from 'expo-constants';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';

import { GatewayDiscoveryScanner, isNativeDiscoveryAvailable } from '@/lib/discovery/scanner';
import { buildGatewayCandidates, friendlyPcName, normalizePcAddress } from '@/lib/gateway/candidates';
import { createClientForKind, type PortalClient } from '@/lib/portal/adapters';
import { createMessageId, extractMessageText, historyToChatMessages } from '@/lib/gateway/messages';
import { loadOrCreateDeviceIdentity } from '@/lib/gateway/device-identity';
import { categorizeProbeError, probeGatewayCandidates, probeGatewayUrl, probeHighPriorityCandidates } from '@/lib/gateway/probe';
import { isSlashCommandInput } from '@/lib/gateway/slash-commands';
import { GATEWAY_COMMANDS } from '@/lib/gateway/dashboard';
import { executeRun, type RunCapableClient } from '@/lib/gateway/runs';
import { notifyApprovalRequired, notifyGatewayDown, notifyRunComplete } from '@/lib/notifications/local';
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
  ChatMessage,
  ConnectionStatus,
  GatewayHelloOk,
  GatewayProfile,
  HermesSession,
  PairingDetails,
} from '@/lib/gateway/types';
import { loadAppSettings, saveAppSettings, type AppSettings } from '@/lib/settings/app-settings';
import {
  appendTranscript,
  loadTranscripts,
  updateTranscript,
} from '@/lib/gateway/transcript';
import type { CommandTranscriptEntry, GatewayCapabilities, GatewayCapabilitySnapshot } from '@/lib/gateway/types';
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
    kind?: GatewayProfile['kind'];
    token?: string;
    bootstrapToken?: string;
    tlsFingerprint?: string;
    sessionKey?: string;
    sessionId?: string;
    agentId?: string;
    discoverySource?: GatewayProfile['discoverySource'];
  }) => Promise<GatewayProfile>;
  gatewayRequest: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;
  runAgentCommand: (command: string, options?: { onDelta?: (delta: string) => void }) => Promise<string>;
  liveCapabilities: GatewayCapabilities | null;
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
  capabilitySnapshot: GatewayCapabilitySnapshot;
  refreshCapabilities: () => void;
  pendingConfirmation: GatewayActionPreview | null;
  confirmPendingAction: () => void;
  cancelPendingConfirmation: () => void;
  pendingRunApproval: { runId: string; prompt: string } | null;
  resolveRunApproval: (approved: boolean, feedback?: string) => void;
  runTask: (
    prompt: string,
    onEvent?: (event: { type: string; data?: Record<string, unknown>; timestamp?: number }) => void,
  ) => Promise<import('@/lib/gateway/runs').RunOutcome>;
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

function readCommandLabel(input: string): string {
  const [command, subcommand] = input.trim().split(/\s+/, 2);
  return [command, subcommand && !subcommand.startsWith('{') ? subcommand : undefined].filter(Boolean).join(' ');
}

function gatewayHostForDisplay(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
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

  push(process.env.EXPO_PUBLIC_HERMES_GATEWAY_HOSTS);
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
  if (!isNativeDiscoveryAvailable()) return [];
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
  const [liveCapabilities, setLiveCapabilities] = useState<GatewayCapabilities | null>(null);
  const [settings, setSettings] = useState<AppSettings>({ autoConnect: true, onboardingComplete: false });
  const settingsRef = useRef<AppSettings>({ autoConnect: true, onboardingComplete: false });
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);
  const [isBootstrapped, setIsBootstrapped] = useState(false);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const [transcripts, setTranscripts] = useState<CommandTranscriptEntry[]>([]);
  const [capabilityCheckedAt, setCapabilityCheckedAt] = useState(() => Date.now());
  const capabilitySnapshot = useMemo<GatewayCapabilitySnapshot>(
    () => buildCapabilitySnapshot(status, activeHello, GATEWAY_COMMANDS, capabilityCheckedAt, liveCapabilities),
    [status, activeHello, liveCapabilities, capabilityCheckedAt],
  );
  const [pendingConfirmation, setPendingConfirmation] = useState<GatewayActionPreview | null>(null);
  const [modelPicker, setModelPicker] = useState<{
    visible: boolean;
    mode: 'default' | 'fallbacks' | 'agent';
    agentId?: string;
  }>({ visible: false, mode: 'default' });
  const [modelCatalog, setModelCatalog] = useState<any[]>([]);
  const [sessionList, setSessionList] = useState<HermesSession[]>([]);
  const [sessionSelector, setSessionSelector] = useState<{ visible: boolean }>({ visible: false });
  const [currentSessionId, setCurrentSessionId] = useState<string | undefined>(undefined);
  const confirmationBypassRef = useRef(false);
  const [pendingRunApproval, setPendingRunApproval] = useState<{ runId: string; prompt: string } | null>(null);
  const runApprovalResolverRef = useRef<((approved: boolean, feedback?: string) => void) | null>(null);
  const runAbortControllerRef = useRef<AbortController | null>(null);
  const gatewayDownNotifiedRef = useRef(false);

  const clientRef = useRef<PortalClient | null>(null);
  const activeRunIdRef = useRef<string | null>(null);
  const sessionIdRef = useRef<string | undefined>(undefined);
  const bootstrapStartedRef = useRef(false);
  const autoConnectInFlightRef = useRef(false);
  const autoRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleAutoRetryRef = useRef<(delayMs?: number) => void>(() => undefined);
  const commandStartTimeRef = useRef<number>(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  const reloadHistoryFor = useCallback(async (gateway: GatewayProfile) => {
    const client = clientRef.current;
    if (!client) return;

    try {
      let sessionId = gateway.sessionId ?? sessionIdRef.current;

      // If no session, list sessions and use the most recent or create one
      if (!sessionId) {
        const sessions = await client.getSessions(5);
        if (sessions.length > 0) {
          sessionId = sessions[0].id;
        } else if (client.createSession) {
          const created = await client.createSession();
          sessionId = created.id;
        }
      }

      sessionIdRef.current = sessionId;
      setCurrentSessionId(sessionId);

      let gatewayMessages: ChatMessage[] = [];
      if (sessionId) {
        try {
          const history = await client.getSessionMessages(sessionId, 80);
          gatewayMessages = historyToChatMessages(history);
        } catch {
          // Session might not exist or be empty
        }
      }

      // Load and merge local command transcripts
      const sessionKey = gateway.sessionKey ?? sessionId ?? 'default';
      const localTrans = await loadTranscripts(gateway.id, sessionKey);
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
    async (gateway: GatewayProfile) => {
      const existing = clientRef.current;
      const existingStatus = existing?.connectionStatus;
      if (
        existing &&
        activeGatewayRef.current?.id === gateway.id &&
        (existingStatus === 'connected' ||
          existingStatus === 'connecting' ||
          existingStatus === 'reconnecting')
      ) {
        return;
      }
      clientRef.current?.disconnect();
      const client = createClientForKind(gateway.kind ?? 'hermes', gateway, {
        onStatus: (nextStatus, detail) => {
          setStatus(nextStatus);
          setStatusDetail(detail ?? '');
          if (nextStatus === 'connected') {
            if (autoRetryTimerRef.current) {
              clearTimeout(autoRetryTimerRef.current);
              autoRetryTimerRef.current = null;
            }
            gatewayDownNotifiedRef.current = false;
            setConnectionPhase('connected');
            setProbeMessage('');
            setLastError(null);
          } else if (nextStatus === 'connecting' || nextStatus === 'reconnecting') {
            setConnectionPhase('connecting');
            setLastError(null);
            if (nextStatus === 'reconnecting' && !gatewayDownNotifiedRef.current) {
              gatewayDownNotifiedRef.current = true;
              void notifyGatewayDown(gatewayHostForDisplay(gateway.url));
            }
          } else if (nextStatus === 'disconnected') {
            setConnectionPhase((phase) =>
              phase === 'connecting' || phase === 'connected' ? 'failed' : phase,
            );
            if (activeGatewayRef.current) {
              scheduleAutoRetryRef.current(12000);
            }
          }
        },
        onHello: (hello) => {
          setActiveHello(hello as GatewayHelloOk);
        },
        onPairingRequired: (details) => {
          setPairingDetails(details as PairingDetails);
        },
        onHealthCheck: (_healthy) => {
          void reloadHistoryFor(gateway);
        },
        onError: (message) => setLastError(message),
      });
      clientRef.current = client;
      setConnectionPhase('connecting');
      await client.connect();
      // Live capability catalog (Hermes /v1/capabilities, OpenClaw capabilities).
      void client.getCapabilities().then(setLiveCapabilities).catch(() => undefined);
    },
    [reloadHistoryFor],
  );

  const connectGateway = useCallback(
    async (gateway: GatewayProfile) => {
      setActiveGateway(gateway);
      setActiveHello(null);
      setMessages([]);
      setLastError(null);
      setIsSending(false);
      activeRunIdRef.current = null;
      sessionIdRef.current = gateway.sessionId;
      await saveActiveGatewayId(gateway.id);
      await attachClient(gateway);
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
      if (existing) {
        if (!token || existing.token === token) return existing;
        const nextProfile = { ...existing, token };
        const next = await upsertGateway(nextProfile);
        setGateways(next);
        return nextProfile;
      }

      const discoveredMatch = discovered.find((item) => item.url === url);
      const profile = createGatewayProfile({
        name: appSettings.pcName ?? discoveredMatch?.name ?? friendlyPcName(appSettings.tailscaleHost ?? 'Gateway'),
        url,
        token,
        kind:
          discoveredMatch && (discoveredMatch.kind === 'openclaw' || discoveredMatch.txt.transport === 'ws')
            ? 'openclaw'
            : undefined,
        discoverySource:
          url.includes('.ts.net') || url.startsWith('https://')
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

        // Kind-flagged beacons (OpenClaw over WS) skip HTTP probing entirely.
        const wsBeacon = discovered.find(
          (gateway) => gateway.kind === 'openclaw' || gateway.txt.transport === 'ws',
        );
        if (wsBeacon) {
          setProbeMessage(`Connecting to ${wsBeacon.name}…`);
          const profile = createGatewayProfile({
            name: wsBeacon.name,
            url: wsBeacon.url,
            kind: 'openclaw',
            discoverySource: 'local',
          });
          const next = await upsertGateway(profile);
          setGateways(next);
          await saveAppSettings({ lastSuccessfulUrl: profile.url });
          setSettings((prev) => ({ ...prev, lastSuccessfulUrl: profile.url }));
          await connectGateway(profile);
          return;
        }

        if (activeId) {
          const saved = currentGateways.find((item) => item.id === activeId);
          if (saved) {
            setProbeMessage(`Reconnecting to ${saved.name}…`);
            // OpenClaw gateways do not answer HTTP /health — connect directly.
            if (saved.kind === 'openclaw') {
              await connectGateway(saved);
              return;
            }
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

        const highPriorityUrls: string[] = [];
        if (Platform.OS === 'web') {
          for (const localUrl of ['http://127.0.0.1:8642', 'http://localhost:8642']) {
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
            setProbeMessage('Add your gateway address to connect.');
            scheduleAutoRetryRef.current(30000);
            return;
          }

          probeResult = await probeGatewayCandidates(candidates, setProbeMessage, 3500);
        }

        if (!probeResult?.ok) {
          setConnectionPhase('failed');
          const hint = categorizeProbeError(probeResult) || (probeResult?.error ? `${probeResult.error}. ` : '');
          setProbeMessage(hint || 'Check that your gateway is running and reachable.');
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

      // Device identity powers pairing/access requests — surface it once.
      void loadOrCreateDeviceIdentity()
        .then((identity) => setDeviceId(identity.deviceId))
        .catch(() => undefined);

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
      setProbeMessage('Could not load saved gateway settings.');
      setLastError(error instanceof Error ? error.message : String(error));
      scheduleAutoRetryRef.current(30000);
    }
  }, [runAutoConnect]);

  useEffect(() => {
    if (bootstrapStartedRef.current) return;
    bootstrapStartedRef.current = true;
    void bootstrap();
    return () => clientRef.current?.disconnect();
  }, [bootstrap]);

  const addGateway = useCallback(
    async (input: {
      name: string;
      url: string;
      kind?: GatewayProfile['kind'];
      token?: string;
      bootstrapToken?: string;
      tlsFingerprint?: string;
      sessionKey?: string;
      sessionId?: string;
      agentId?: string;
      discoverySource?: GatewayProfile['discoverySource'];
    }) => {
      const profile = createGatewayProfile(input);
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
      return client.rpcRequest<T>(method, params);
    },
    [status],
  );

  const runAgentCommand = useCallback(
    async (command: string, options?: { onDelta?: (delta: string) => void }) => {
      const gateway = activeGateway;
      const client = clientRef.current;
      const trimmed = command.trim();
      if (!trimmed || !gateway || !client || status !== 'connected') {
        throw new Error('Connect to a gateway first');
      }

      // Use the streaming chat endpoint; surface deltas when asked.
      const runId = createMessageId('cmd');
      activeRunIdRef.current = runId;

      let fullText = '';
      const messages = [{ role: 'user', content: trimmed }];
      await client.streamChat(
        messages,
        (delta) => {
          fullText += delta;
          options?.onDelta?.(delta);
        },
        {
          sessionId: sessionIdRef.current,
          model: gateway.model,
        },
      );
      return fullText;
    },
    [activeGateway, status],
  );

  const appendLocalMessage = useCallback((role: ChatMessage['role'], text: string, command?: ChatMessage['command']) => {
    const id = createMessageId(role === 'user' ? 'user' : 'cmd');
    const ts = Date.now();

    const msg: ChatMessage = { id, role, text, timestamp: ts, command };
    setMessages((prev) => [...prev, msg]);

    if (command?.input && activeGateway) {
      const sessionKey = activeGateway.sessionKey ?? sessionIdRef.current ?? 'default';
      const entry: CommandTranscriptEntry = {
        id,
        gatewayId: activeGateway.id,
        sessionKey,
        sessionId: sessionIdRef.current,
        input: command.input,
        title: command.title ?? readCommandLabel(command.input),
        status: (command.status as any) ?? 'running',
        summary: text,
        raw: command.raw,
        createdAt: ts,
        ephemeral: command.ephemeral ?? true,
      };
      void appendTranscript(activeGateway.id, sessionKey, entry).then((updated) => {
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

    if (activeGateway) {
      const statusPatch: Partial<CommandTranscriptEntry> = {};
      if (patch.command?.status) statusPatch.status = patch.command.status as any;
      if (patch.text) statusPatch.summary = patch.text;
      if (patch.command?.raw) statusPatch.raw = patch.command.raw;
      if (Object.keys(statusPatch).length > 0) {
        if (commandStartTimeRef.current) {
          statusPatch.durationMs = Date.now() - commandStartTimeRef.current;
        }
        const sessionKey = activeGateway.sessionKey ?? sessionIdRef.current ?? 'default';
        void updateTranscript(activeGateway.id, sessionKey, id, statusPatch).then((updated) => {
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
      await saveActiveGatewayId(null);
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

      // Add streaming placeholder
      setMessages((prev) => [...prev, {
        id: `run-${runId}`,
        role: 'assistant',
        text: '',
        streaming: true,
        timestamp: Date.now(),
      }]);

      try {
        // Build bounded conversation context: last 20 real turns, no command payloads.
        const conversationMessages = [
          ...messages
            .filter((m) => (m.role === 'user' || m.role === 'assistant') && !m.command && m.text.trim())
            .slice(-20)
            .map((m) => ({ role: m.role, content: m.text })),
          { role: 'user', content: trimmed },
        ];

        const abortController = new AbortController();
        abortControllerRef.current = abortController;

        await client.streamChat(
          conversationMessages,
          (delta) => {
            setMessages((prev) => {
              const idx = prev.findIndex((m) => m.id === `run-${runId}`);
              if (idx < 0) return prev;
              const copy = [...prev];
              copy[idx] = {
                ...copy[idx],
                text: copy[idx].text + delta,
                streaming: true,
              };
              return copy;
            });
          },
          {
            sessionId: sessionIdRef.current,
            model: gateway.model,
            signal: abortController.signal,
          },
        );

        // Mark as complete
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === `run-${runId}`);
          if (idx < 0) return prev;
          const copy = [...prev];
          copy[idx] = { ...copy[idx], streaming: false };
          return copy;
        });
        setLastError(null);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('abort') || message.includes('Abort')) {
          // User cancelled — remove the streaming placeholder
          setMessages((prev) => prev.filter((m) => m.id !== `run-${runId}`));
        } else {
          setLastError(message);
          setMessages((prev) => {
            const idx = prev.findIndex((m) => m.id === `run-${runId}`);
            if (idx < 0) return prev;
            const copy = [...prev];
            copy[idx] = {
              ...copy[idx],
              text: `Error: ${message}`,
              streaming: false,
            };
            return copy;
          });
        }
      } finally {
        setIsSending(false);
        activeRunIdRef.current = null;
        abortControllerRef.current = null;
      }
    },
    [activeGateway, isSending, messages, status],
  );

  const resolveRunApproval = useCallback((approved: boolean, feedback?: string) => {
    runApprovalResolverRef.current?.(approved, feedback);
    runApprovalResolverRef.current = null;
    setPendingRunApproval(null);
  }, []);

  const runTask = useCallback(
    async (
      prompt: string,
      onEvent?: (event: { type: string; data?: Record<string, unknown>; timestamp?: number }) => void,
    ) => {
      const client = clientRef.current;
      const gateway = activeGatewayRef.current;
      if (
        !client ||
        !gateway ||
        status !== 'connected' ||
        !client.startRun ||
        !client.getRunStatus ||
        !client.streamRunEvents ||
        !client.resolveApproval
      ) {
        throw new Error('This gateway does not support agentic runs (the Hermes run API is required).');
      }
      const runCapable = client as unknown as RunCapableClient;
      const abortController = new AbortController();
      runAbortControllerRef.current?.abort();
      runAbortControllerRef.current = abortController;

      try {
        const outcome = await executeRun(runCapable, prompt, {
          sessionId: sessionIdRef.current,
          model: gateway.model,
          signal: abortController.signal,
          onEvent: (event) => {
            onEvent?.({
              type: event.type,
              data: event.data,
              timestamp: event.timestamp,
            });
          },
          onApprovalRequired: (runId) => {
            setPendingRunApproval({ runId, prompt });
            void notifyApprovalRequired(prompt);
            return new Promise<{ approved: boolean; feedback?: string }>((resolve) => {
              const onAbort = () => {
                runApprovalResolverRef.current = null;
                resolve({ approved: false });
              };
              runApprovalResolverRef.current = (approved: boolean, feedback?: string) => {
                abortController.signal.removeEventListener('abort', onAbort);
                resolve({ approved, feedback });
              };
              abortController.signal.addEventListener('abort', onAbort, { once: true });
            });
          },
        });

        if (!outcome.cancelled) {
          const succeeded = /(complete|succeeded|success|done|finished)/i.test(outcome.status);
          const summary = (outcome.error ?? outcome.result ?? outcome.status ?? '').slice(0, 120);
          void notifyRunComplete(
            succeeded ? 'Run complete' : outcome.status === 'cancelled' ? 'Run cancelled' : 'Run finished',
            summary || outcome.status,
          );
        }
        return outcome;
      } finally {
        runAbortControllerRef.current = null;
      }
    },
    [status],
  );

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

      const needsConfirmation =
        matchingCmd &&
        (matchingCmd.danger === 'write' || matchingCmd.danger === 'destructive') &&
        !hasConfirmFlag &&
        !confirmationBypassRef.current;

      if (needsConfirmation) {
        const previewSummary = `This will perform a ${matchingCmd.danger} action on the gateway.`;
        const preview: GatewayActionPreview = {
          title: matchingCmd.label || commandLabel,
          summary: previewSummary,
          risk: matchingCmd.danger === 'destructive' ? 'high' : 'medium',
          applyCommand: trimmed,
        };
        setPendingConfirmation(preview);
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
        const client = clientRef.current;
        if (!client || status !== 'connected') throw new Error('Gateway not connected');

        // Execute gateway slash command — stream agent-transport output live.
        let streamedText = '';
        const { executeGatewaySlashCommand } = await import('@/lib/gateway/slash-commands');
        const response = await executeGatewaySlashCommand(trimmed, {
          hello: activeHello,
          gatewayRequest,
          runAgentCommand,
          runTask,
          onAgentDelta: (delta) => {
            streamedText += delta;
            updateLocalMessage(commandMessageId, {
              text: streamedText,
              command: { input: trimmed, title: commandLabel, status: 'running', ephemeral: true },
            });
          },
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
        if (activeGateway) {
          const sessionKey = activeGateway.sessionKey ?? sessionIdRef.current ?? 'default';
          void updateTranscript(activeGateway.id, sessionKey, commandMessageId, {
            summary: response.text,
            raw: response.raw,
            status: 'complete',
            durationMs: duration,
          }).then((t) => setTranscripts(t));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setLastError(message);
        updateLocalMessage(commandMessageId, {
          text: `Command failed: ${message}`,
          command: { input: trimmed, title: commandLabel, status: 'error', ephemeral: true },
        });
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
      runAgentCommand,
      runTask,
      sendMessage,
      status,
      updateLocalMessage,
    ],
  );

  const openModelPicker = useCallback(async (mode: 'default' | 'fallbacks' | 'agent', agentId?: string) => {
    try {
      const client = clientRef.current;
      if (client) {
        const models = await client.getModels();
        setModelCatalog(models);
      }
    } catch {
      // Keep picker usable with any cached catalog
    }
    setModelPicker({ visible: true, mode, agentId });
  }, []);

  const closeModelPicker = useCallback(() => {
    setModelPicker({ visible: false, mode: 'default' });
  }, []);

  const openSessionSelector = useCallback(async () => {
    try {
      const client = clientRef.current;
      if (client) {
        const sessions = await client.getSessions(20);
        setSessionList(sessions);
      }
    } catch {
      // Keep selector usable
    }
    setSessionSelector({ visible: true });
  }, []);

  const closeSessionSelector = useCallback(() => {
    setSessionSelector({ visible: false });
  }, []);

  const stopStreaming = useCallback(async () => {
    setIsSending(false);
    activeRunIdRef.current = null;

    // Abort the fetch controller — this stops the local stream; the adapter
    // (OpenClaw) additionally issues session.abort via the signal listener.
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    // Abort an in-flight agentic run (denies any pending approval).
    if (runAbortControllerRef.current) {
      runAbortControllerRef.current.abort();
      runAbortControllerRef.current = null;
    }

    // Remove streaming placeholders
    setMessages((prev) => prev.filter((m) => !m.streaming));
  }, []);

  const reloadHistory = useCallback(async () => {
    if (!activeGateway) return;
    await reloadHistoryFor(activeGateway);
  }, [activeGateway, reloadHistoryFor]);

  const setupFromPcAddress = useCallback(
    async (pcAddress: string, token?: string) => {
      const host = normalizePcAddress(pcAddress);
      if (!host) throw new Error('Enter your gateway address');

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

      let probeResult = await probeHighPriorityCandidates(candidates, setProbeMessage, 3000);

      if (!probeResult?.ok) {
        probeResult = await probeGatewayCandidates(candidates.slice(3), setProbeMessage, 3500);
      }
      if (!probeResult?.ok) {
        setConnectionPhase('failed');
        const hint = categorizeProbeError(probeResult) || (probeResult?.error ? `${probeResult.error}. ` : '');
        setProbeMessage(
          `${hint}Saved your address, but could not reach the gateway. Make sure it is running and exposed over Tailscale or local network.`,
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

  useEffect(() => {
    scheduleAutoRetryRef.current = scheduleAutoRetry;
  }, [scheduleAutoRetry]);

  // Fast-path recovery to the last-known gateway — skips the discovery/probe
  // ceremony when we already know the endpoint. Falls back to the full
  // auto-connect loop only when the fast path cannot reach it.
  const reconnectLastKnownGateway = useCallback(async () => {
    const active = activeGatewayRef.current;
    if (!active) {
      void retryAutoConnect();
      return;
    }
    if (active.kind === 'openclaw') {
      await connectGateway(active);
      return;
    }
    const probe = await probeGatewayUrl(active.url, 3500);
    if (probe.ok) {
      await connectGateway(active);
      return;
    }
    void retryAutoConnect();
  }, [connectGateway, retryAutoConnect]);

  // Foreground/background lifecycle: pause reconnection while backgrounded
  // (timers are throttled anyway), heal fast on return to foreground.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') {
        clientRef.current?.suspendReconnect();
        if (autoRetryTimerRef.current) {
          clearTimeout(autoRetryTimerRef.current);
          autoRetryTimerRef.current = null;
        }
        return;
      }

      const client = clientRef.current;
      if (client?.connectionStatus === 'reconnecting') {
        client.resumeReconnect();
        return;
      }
      if (connectionPhaseRef.current === 'connected') return;
      void reconnectLastKnownGateway();
    });
    return () => subscription.remove();
  }, [reconnectLastKnownGateway]);

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
    void sendChatInput(entry.input);
  }, [sendChatInput]);

  const cancelCommand = useCallback((id: string) => {
    if (activeGateway) {
      const sessionKey = activeGateway.sessionKey ?? sessionIdRef.current ?? 'default';
      void updateTranscript(activeGateway.id, sessionKey, id, {
        status: 'cancelled',
      }).then((t) => setTranscripts(t));
    }
    setIsCommandRunning(false);
    setRunningCommandLabel(null);
    void reloadHistory();
  }, [activeGateway, reloadHistory]);

  const refreshCapabilities = useCallback(async () => {
    if (!activeGateway) return;
    try {
      const client = clientRef.current;
      if (client && status === 'connected') {
        await client.healthCheck();
        void client.getCapabilities().then(setLiveCapabilities).catch(() => undefined);
      }
      setCapabilityCheckedAt(Date.now());
    } catch {
      // ignore
    }
  }, [activeGateway, status]);

  const confirmPendingAction = useCallback(() => {
    if (!pendingConfirmation || !activeGateway) {
      setPendingConfirmation(null);
      return;
    }
    const apply = pendingConfirmation.applyCommand;
    setPendingConfirmation(null);
    confirmationBypassRef.current = true;
    void sendChatInput(apply + (apply.includes('--confirm') ? '' : ' --confirm')).finally(() => {
      confirmationBypassRef.current = false;
    });
  }, [pendingConfirmation, activeGateway, sendChatInput]);

  const cancelPendingConfirmation = useCallback(() => {
    setPendingConfirmation(null);
  }, []);

  const selectModel = useCallback(
    (modelId: string) => {
      closeModelPicker();
      if (activeGateway?.kind === 'openclaw') {
        // OpenClaw: model is gateway config — run the config command.
        void sendChatInput(`/model set ${modelId}`);
        return;
      }
      // Hermes: per-request model override (API server honors model per request).
      if (!activeGateway) return;
      const updated = { ...activeGateway, model: modelId };
      setActiveGateway(updated);
      void upsertGateway(updated).then(setGateways);
    },
    [activeGateway, closeModelPicker, sendChatInput],
  );

  const selectSession = useCallback((sessionId: string) => {
    closeSessionSelector();
    sessionIdRef.current = sessionId;
    setCurrentSessionId(sessionId);
    if (activeGateway) {
      void reloadHistoryFor(activeGateway);
    }
  }, [closeSessionSelector, activeGateway, reloadHistoryFor]);

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
      liveCapabilities,
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
      pendingRunApproval,
      resolveRunApproval,
      runTask,
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
      gateways, activeGateway, activeHello, status, statusDetail, connectionPhase, probeMessage,
      messages, isSending, isCommandRunning, runningCommandLabel, lastError, deviceId, pairingDetails,
      settings, isBootstrapped, needsOnboarding, refreshGateways, addGateway, deleteGateway,
      connectGateway, disconnectGateway, sendMessage, sendChatInput, stopStreaming, reloadHistory,
      gatewayRequest, runAgentCommand, setupFromPcAddress, retryAutoConnect, completeOnboarding,
      setAutoConnect, transcripts, retryCommand, cancelCommand, capabilitySnapshot,
      refreshCapabilities, pendingConfirmation, confirmPendingAction, cancelPendingConfirmation,
      pendingRunApproval, resolveRunApproval, runTask, modelPicker, openModelPicker, closeModelPicker,
      selectModel, modelCatalog, sessionSelector,
      openSessionSelector, closeSessionSelector, selectSession, sessionList, currentSessionId,
      liveCapabilities,
    ],
  );

  return <GatewayContext.Provider value={value}>{children}</GatewayContext.Provider>;
}

export function useGateway() {
  const context = useContext(GatewayContext);
  if (!context) throw new Error('useGateway must be used within GatewayProvider');
  return context;
}