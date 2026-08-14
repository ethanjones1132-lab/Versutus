import Constants from 'expo-constants';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';

import { GatewayDiscoveryScanner, isNativeDiscoveryAvailable } from '@/lib/discovery/scanner';
import { buildGatewayCandidates, friendlyPcName, normalizePcAddress } from '@/lib/gateway/candidates';
import { createClientForKind, type PortalClient } from '@/lib/portal/adapters';
import { createMessageId, historyToChatMessages, pickAppSession } from '@/lib/gateway/messages';
import { loadOrCreateDeviceIdentity } from '@/lib/gateway/device-identity';
import { categorizeProbeError, probeGatewayCandidates, probeGatewayUrl, probeHighPriorityCandidates } from '@/lib/gateway/probe';
import { isSlashCommandInput } from '@/lib/gateway/slash-commands';
import { findConfirmableSlash } from '@/lib/gateway/command-match';
import { GATEWAY_COMMANDS } from '@/lib/gateway/dashboard';
import { manifestUrlForGateway } from '@/lib/gateway/gateway-origin';
import { loadRecentCommands, pushRecentCommand } from '@/lib/gateway/recents';
import { ACTIVITY_EVENT_CAP, executeRun, runEventPreview, type ActivityRun, type RunCapableClient } from '@/lib/gateway/runs';
import {
  loadActivityRuns,
  loadOfflineQueue,
  saveActivityRuns,
  saveOfflineQueue,
  type OfflineQueueItem,
} from '@/lib/gateway/session-persistence';
import { syncChildProfiles } from '@/lib/gateway/child-sync';
import { notifyApprovalRequired, notifyGatewayDown, notifyRunComplete } from '@/lib/notifications/local';
import type {
  ChatMessage,
  CommandTranscriptEntry,
  ConnectionStatus,
  GatewayActionPreview,
  GatewayCapabilities,
  GatewayCapabilitySnapshot,
  GatewayHelloOk,
  GatewayProfile,
  HermesSession,
  PairingDetails,
} from '@/lib/gateway/types';
import {
  createGatewayProfile,
  loadActiveGatewayId,
  loadGateways,
  removeGateway,
  saveActiveGatewayId,
  upsertGateway,
} from '@/lib/gateway/storage';
import {
  fetchGatewayManifest,
  manifestAuthSchemes,
  manifestCapabilityInstances,
  manifestDynamicCommands,
  manifestKindLabel,
  manifestProviders,
  manifestRequiresToken,
  type GatewayCapabilityCommand,
  type GatewayManifest,
} from '@/lib/portal/manifest';
import { identifyGateway, type GatewayIdentity } from '@/lib/portal/identify';
import { loadAppSettings, saveAppSettings, type AppSettings } from '@/lib/settings/app-settings';
import {
  appendTranscript,
  loadTranscripts,
  updateTranscript,
} from '@/lib/gateway/transcript';
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
  dynamicCommands: GatewayCapabilityCommand[];
  deleteGateway: (id: string) => Promise<void>;
  connectGateway: (gateway: GatewayProfile) => Promise<void>;
  disconnectGateway: () => void;
  sendMessage: (text: string, existingMessageId?: string) => Promise<void>;
  sendChatInput: (
    text: string,
    options?: { fromQueue?: boolean; messageId?: string },
  ) => Promise<void>;
  stopStreaming: () => Promise<void>;
  reloadHistory: () => Promise<void>;
  setupFromPcAddress: (pcAddress: string, token?: string) => Promise<boolean>;
  retryAutoConnect: () => Promise<void>;
  completeOnboarding: () => Promise<void>;
  setAutoConnect: (enabled: boolean) => Promise<void>;
  transcripts: CommandTranscriptEntry[];
  recentCommands: string[];
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
  /** Runs initiated from this app (newest first), for the Activity surface. */
  activityRuns: ActivityRun[];
  /** Stop a running run: aborts the local driver and asks the gateway to stop it. */
  stopActivityRun: (runId: string) => void;
  modelPicker: {
    visible: boolean;
    mode: 'default' | 'fallbacks' | 'agent';
    agentId?: string;
  };
  openModelPicker: (mode: 'default' | 'fallbacks' | 'agent', agentId?: string) => void;
  closeModelPicker: () => void;
  selectModel: (modelId: string, providerId?: string) => void;
  modelCatalog: any[];
  sessionSelector: { visible: boolean };
  openSessionSelector: () => void;
  closeSessionSelector: () => void;
  selectSession: (sessionId: string) => void;
  sessionList: any[];
  currentSessionId?: string;
  /** True while session history is being (re)loaded — drives chat skeletons. */
  historyLoading: boolean;
  /** Create a fresh session on the gateway and make it current. */
  createNewSession: () => Promise<void>;
  /** Delete a session on the gateway (when the adapter supports it). */
  deleteSessionById: (sessionId: string) => Promise<void>;
  /** Remove a message from the local view (not propagated to the gateway). */
  deleteLocalMessage: (id: string) => void;
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

function tryParseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function lookupPath(root: Record<string, unknown> | null | undefined, path: string): unknown {
  if (!root) return undefined;
  let node: unknown = root;
  for (const part of path.split('.')) {
    if (node && typeof node === 'object') {
      node = (node as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return node;
}

function safeStringify(value: unknown): string {
  if (value === undefined) return '(unset)';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

async function buildActionPreview(
  input: string,
  command: { label: string; danger?: string } | null,
  label: string,
  gatewayRequest: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>,
): Promise<GatewayActionPreview> {
  const risk: 'medium' | 'high' = command?.danger === 'destructive' ? 'high' : 'medium';
  const base: GatewayActionPreview = {
    title: command?.label ?? label,
    risk,
    applyCommand: input,
    summary: `This will perform a ${command?.danger ?? 'write'} action on the gateway.`,
  };
  const tokens = input.trim().toLowerCase().split(/\s+/);

  if (tokens[0] === '/config' && tokens[1] === 'patch') {
    const patchText = input.trim().slice('/config patch'.length).trim();
    const patch = tryParseJsonObject(patchText);
    if (patch) {
      const keys = Object.keys(patch);
      let current: Record<string, unknown> | null = null;
      try {
        current = await gatewayRequest<Record<string, unknown>>('config.get', {});
      } catch {
        current = null;
      }
      const diff = keys.map((key) => ({
        label: key,
        before: safeStringify(lookupPath(current, key)),
        after: safeStringify(patch[key]),
      }));
      return {
        ...base,
        summary: `This will write ${keys.length} config ${keys.length === 1 ? 'key' : 'keys'} to the gateway.`,
        diff,
      };
    }
  }

  if (tokens[0] === '/channel' && (tokens[1] === 'stop' || tokens[1] === 'logout')) {
    const target = input.trim().split(/\s+/).slice(2).join(' ') || 'channel';
    return {
      ...base,
      title: `${command?.label ?? 'Channel action'}${target !== 'channel' ? ` · ${target}` : ''}`,
      summary:
        tokens[1] === 'logout'
          ? `This will log out the ${target} account on the gateway. Ongoing sessions will be signed out.`
          : `This will stop the ${target} on the gateway. Ongoing channel sessions will be interrupted.`,
      affectedTarget: target,
    };
  }

  return {
    ...base,
    summary: `This will perform a ${command?.danger ?? 'write'} action on the gateway.`,
  };
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
  // `openClawGatewayHosts` remains a read-only migration fallback for old
  // builds/configs; new config uses the gateway-neutral name.
  const extraHosts = extra?.gatewayHosts ?? extra?.openClawGatewayHosts;
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

function isGatewayAuthFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:401|403|invalid api key|unauthorized|authentication required)/i.test(message);
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
  const [activeManifest, setActiveManifest] = useState<GatewayManifest | null>(null);
  const [settings, setSettings] = useState<AppSettings>({ autoConnect: true, onboardingComplete: false });
  const settingsRef = useRef<AppSettings>({ autoConnect: true, onboardingComplete: false });
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);
  const [isBootstrapped, setIsBootstrapped] = useState(false);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const [transcripts, setTranscripts] = useState<CommandTranscriptEntry[]>([]);
  const [capabilityCheckedAt, setCapabilityCheckedAt] = useState(() => Date.now());
  const capabilityInstances = useMemo(
    () => (activeManifest ? manifestCapabilityInstances(activeManifest) : []),
    [activeManifest],
  );
  const dynamicCommands = useMemo(
    () => (activeManifest ? manifestDynamicCommands(activeManifest) : []),
    [activeManifest],
  );
  const capabilitySnapshot = useMemo<GatewayCapabilitySnapshot>(
    () =>
      buildCapabilitySnapshot(
        status,
        activeHello,
        GATEWAY_COMMANDS,
        capabilityCheckedAt,
        liveCapabilities,
        capabilityInstances,
      ),
    [status, activeHello, liveCapabilities, capabilityCheckedAt, capabilityInstances],
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
  const [historyLoading, setHistoryLoading] = useState(false);
  const confirmationBypassRef = useRef(false);
  const [recentCommands, setRecentCommands] = useState<string[]>([]);
  const [pendingRunApproval, setPendingRunApproval] = useState<{ runId: string; prompt: string } | null>(null);
  const [activityRuns, setActivityRuns] = useState<ActivityRun[]>([]);
  const runApprovalResolverRef = useRef<((approved: boolean, feedback?: string) => void) | null>(null);
  const runAbortControllerRef = useRef<AbortController | null>(null);
  const gatewayDownNotifiedRef = useRef(false);
  const authFailureRef = useRef(false);

  const clientRef = useRef<PortalClient | null>(null);
  /**
   * Bumped on every attach/teardown. Callbacks from a superseded client carry a
   * stale generation and are ignored, so a torn-down client cannot push status,
   * schedule a competing retry, or overwrite state for the client that replaced it.
   */
  const clientGenerationRef = useRef(0);
  const historyLoadedForRef = useRef<string | null>(null);
  const historyRequestRef = useRef(0);
  const activeRunIdRef = useRef<string | null>(null);
  const sessionIdRef = useRef<string | undefined>(undefined);
  const bootstrapStartedRef = useRef(false);
  const autoConnectInFlightRef = useRef(false);
  const autoRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleAutoRetryRef = useRef<(delayMs?: number) => void>(() => undefined);
  const commandStartTimeRef = useRef<number>(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const offlineQueueRef = useRef<OfflineQueueItem[]>([]);
  const flushingOfflineRef = useRef(false);

  const persistOfflineQueue = useCallback(() => {
    void saveOfflineQueue(offlineQueueRef.current);
  }, []);

  const patchActivityRuns = useCallback((updater: (prev: ActivityRun[]) => ActivityRun[]) => {
    setActivityRuns((prev) => {
      const next = updater(prev);
      void saveActivityRuns(next);
      return next;
    });
  }, []);

  const reloadHistoryFor = useCallback(async (gateway: GatewayProfile) => {
    const client = clientRef.current;
    if (!client) return;

    const requestId = ++historyRequestRef.current;
    historyLoadedForRef.current = gateway.id;
    setHistoryLoading(true);
    try {
      // A deliberate session switch updates the ref; do not let the profile's
      // initial session override it on every history reload.
      let sessionId = sessionIdRef.current ?? gateway.sessionId;
      let sessionsPromise: Promise<HermesSession[]> | null = null;
      let availableSessions: HermesSession[] = [];

      // Resume this app's own most recent session, or start a fresh one. The
      // session selector still lists every session for deliberate switching.
      if (!sessionId) {
        sessionsPromise = client.getSessions(20).catch(() => [] as HermesSession[]);
        void sessionsPromise.then((sessions) => {
          if (requestId === historyRequestRef.current) setSessionList(sessions);
        });
        availableSessions = await sessionsPromise;
        const own = pickAppSession(availableSessions);
        if (own) {
          sessionId = own.id;
        } else if (client.createSession) {
          const created = await client.createSession();
          sessionId = created.id;
        }
      }

      sessionIdRef.current = sessionId;
      setCurrentSessionId(sessionId);

      const sessionKey = gateway.sessionKey ?? sessionId ?? 'default';
      const [gatewayHistory, localTrans] = await Promise.all([
        sessionId
           ? client.getSessionMessages(sessionId, 80).catch(() => [])
           : Promise.resolve([]),
         loadTranscripts(gateway.id, sessionKey),
      ]);
      if (requestId !== historyRequestRef.current) return;
      const gatewayMessages = historyToChatMessages(gatewayHistory);
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

      // Re-surface durable offline outbox items after history reload.
      const pending = offlineQueueRef.current.filter((item) => item.gatewayId === gateway.id);
      for (const item of pending) {
        if (!merged.some((m) => m.id === item.id)) {
          merged.push({
            id: item.id,
            role: 'user',
            text: item.text,
            timestamp: item.createdAt,
            queued: true,
          });
        }
      }

      setMessages(merged);
      setLastError(null);
    } catch (error) {
      if (requestId !== historyRequestRef.current) return;
      setLastError(error instanceof Error ? error.message : String(error));
    } finally {
      if (requestId === historyRequestRef.current) setHistoryLoading(false);
    }
  }, []);

  const attachClient = useCallback(
    async (gatewayInput: GatewayProfile) => {
      let gateway = gatewayInput;
      authFailureRef.current = false;
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
      // Supersede the outgoing client so its teardown cannot drive provider state.
      clientGenerationRef.current += 1;
      setActiveManifest(null);
      const generation = clientGenerationRef.current;
      const isCurrent = () => clientGenerationRef.current === generation;
      clientRef.current?.disconnect();

      let identityForClient: GatewayIdentity | undefined;
      let parentUrl: string | undefined;
      // OpenClaw is WS-only. Everything else (including profiles saved without a
      // kind from onboarding) is identified from the well-known when present so
      // Gate is never forced through the Hermes adapter.
      let clientKind = gateway.kind ?? 'hermes';
      if (gateway.kind !== 'openclaw') {
        // Child profiles are materialised under parent.url + basePath and do
        // not host their own well-known manifest — fetch the parent's.
        if (gateway.parentId) {
          const known = await loadGateways();
          parentUrl = known.find((item) => item.id === gateway.parentId)?.url;
        }
        const manifestUrl = manifestUrlForGateway(gateway, parentUrl);
        const manifest = await fetchGatewayManifest(manifestUrl).catch(() => null);
        // Another attachClient may have superseded us while we awaited.
        if (!isCurrent()) return;
        if (manifest) {
          setActiveManifest(manifest);
          clientKind = 'custom';
          const providers = manifestProviders(manifest);
          identityForClient = {
            kind: 'custom',
            kindLabel: manifestKindLabel(manifest),
            manifest,
            providers,
            auth: {
              schemes: manifestAuthSchemes(manifest),
              requiresToken: manifestRequiresToken(manifest),
              grantPath: manifest.auth?.grantPath,
            },
            source: 'manifest',
            identifiedAt: Date.now(),
          };
          const firstModel = providers[0]?.models?.[0];
          const needsKind = gateway.kind !== 'custom';
          const needsModel = !gateway.model && typeof firstModel === 'string' && firstModel.length > 0;
          if (needsKind || needsModel) {
            const corrected = {
              ...gateway,
              ...(needsKind ? { kind: 'custom' as const } : {}),
              ...(needsModel ? { model: firstModel } : {}),
            };
            gateway = corrected;
            setActiveGateway(corrected);
            void upsertGateway(corrected).then(setGateways);
          }
        }
      }

      if (!isCurrent()) return;

      const client = createClientForKind(
        clientKind,
        gateway,
        {
          onStatus: (nextStatus, detail) => {
            if (!isCurrent()) return;
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
              // Only a fresh attempt clears the last failure. 'reconnecting' is
              // reported immediately after onError, so clearing here wiped the
              // reason before it could ever be shown.
              if (nextStatus === 'connecting') setLastError(null);
              if (nextStatus === 'reconnecting' && !gatewayDownNotifiedRef.current) {
                gatewayDownNotifiedRef.current = true;
                void notifyGatewayDown(gatewayHostForDisplay(gateway.url));
              }
            } else if (nextStatus === 'disconnected') {
              setConnectionPhase((phase) =>
                phase === 'connecting' || phase === 'connected' ? 'failed' : phase,
              );
              if (activeGatewayRef.current && !authFailureRef.current) {
                scheduleAutoRetryRef.current(12000);
              }
            }
          },
          onHello: (hello) => {
            if (isCurrent()) setActiveHello(hello as GatewayHelloOk);
          },
          onCapabilities: (capabilities) => {
            if (isCurrent()) setLiveCapabilities(capabilities as GatewayCapabilities);
          },
          onPairingRequired: (details) => {
            if (isCurrent()) setPairingDetails(details as PairingDetails);
          },
          onHealthCheck: (_healthy) => {
            // Only on the first connect to this gateway. Reloading on every
            // reconnect rebuilds the message list underneath the user.
            if (!isCurrent() || historyLoadedForRef.current === gateway.id) return;
            void reloadHistoryFor(gateway);
          },
          onError: (message) => {
            if (isCurrent()) setLastError(message);
          },
        },
        identityForClient,
      );
      clientRef.current = client;
      historyLoadedForRef.current = null;
      setConnectionPhase('connecting');
      // connect() rejects only on auth rejection; unreachable gateways are left
      // in 'reconnecting' with backoff running.
      try {
        await client.connect();
      } catch (error) {
        if (isGatewayAuthFailure(error)) authFailureRef.current = true;
        throw error;
      }

      // Pin a default model so chat is not sent with model: undefined (Gate
      // would 404 "No provider declares model undefined").
      if (!gateway.model && isCurrent()) {
        try {
          const models = await client.getModels();
          const first = models[0]?.id;
          if (first && isCurrent()) {
            const withModel = { ...gateway, model: first };
            setActiveGateway(withModel);
            void upsertGateway(withModel).then(setGateways);
          }
        } catch {
          // optional
        }
      }

      // Fetch is cheap and idempotent; only a manifest-serving gate returns
      // providers[] at all, so this is a no-op against Hermes/OpenClaw.
      // Always use the parent origin — a child /p/{id} URL does not host the
      // well-known document, and syncing children from a child is wrong.
      void fetchGatewayManifest(manifestUrlForGateway(gateway, parentUrl))
        .then((manifest) => {
          if (!manifest || !isCurrent()) return;
          setActiveManifest(manifest);
          if (gateway.parentId) return undefined;
          return syncChildProfiles(gateway, manifestProviders(manifest));
        })
        .then((next) => {
          if (next && isCurrent()) setGateways(next);
        })
        .catch(() => undefined);
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
      let kind: GatewayProfile['kind'] =
        discoveredMatch && (discoveredMatch.kind === 'openclaw' || discoveredMatch.txt.transport === 'ws')
          ? 'openclaw'
          : undefined;
      // Onboarding used to leave kind unset, which defaulted the client to Hermes
      // and broke Gate (manifest on :8760). Identify before saving.
      if (!kind) {
        const identity = await identifyGateway({ baseUrl: url });
        if (identity.kind === 'custom' || identity.kind === 'hermes' || identity.kind === 'openclaw') {
          kind = identity.kind;
        }
      }
      const profile = createGatewayProfile({
        name: appSettings.pcName ?? discoveredMatch?.name ?? friendlyPcName(appSettings.tailscaleHost ?? 'Gateway'),
        url,
        token,
        kind,
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
      const [loadedSettings, loadedGateways, activeId, restoredQueue, restoredRuns] = await Promise.all([
        loadAppSettings(),
        loadGateways(),
        loadActiveGatewayId(),
        loadOfflineQueue(),
        loadActivityRuns(),
      ]);

      setSettings(loadedSettings);
      setGateways(loadedGateways);
      offlineQueueRef.current = restoredQueue;
      setActivityRuns(restoredRuns);

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
        setProbeMessage(
          isGatewayAuthFailure(error)
            ? 'Gateway rejected the API key. Update it from the gateway settings.'
            : 'Auto-connect failed. Tap retry or check your gateway address.',
        );
        setLastError(error instanceof Error ? error.message : String(error));
        if (!isGatewayAuthFailure(error)) scheduleAutoRetryRef.current(18000);
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

  const appendLocalMessage = useCallback(
    (
      role: ChatMessage['role'],
      text: string,
      command?: ChatMessage['command'],
      queued = false,
    ) => {
    const id = createMessageId(role === 'user' ? 'user' : 'cmd');
    const ts = Date.now();

    const msg: ChatMessage = { id, role, text, timestamp: ts, command, queued };
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
    },
    [activeGateway],
  );

  const queueOfflineInput = useCallback(
    (text: string) => {
      const gatewayId = activeGatewayRef.current?.id ?? '';
      const id = appendLocalMessage('user', text, undefined, true);
      offlineQueueRef.current.push({ id, text, gatewayId, createdAt: Date.now() });
      persistOfflineQueue();
      setLastError(null);
    },
    [appendLocalMessage, persistOfflineQueue],
  );

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
    // Cascade removes child profiles too — tear down if the active gateway
    // was the deleted parent or one of its children.
    const activeWasRemoved =
      activeGateway?.id === id || activeGateway?.parentId === id;
    if (activeWasRemoved) {
      clientGenerationRef.current += 1;
      if (autoRetryTimerRef.current) {
        clearTimeout(autoRetryTimerRef.current);
        autoRetryTimerRef.current = null;
      }
      clientRef.current?.disconnect();
      clientRef.current = null;
      setActiveGateway(null);
      setActiveHello(null);
      setActiveManifest(null);
      setLiveCapabilities(null);
      setStatus('disconnected');
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
    // Supersede first: the client emits 'disconnected' synchronously, and the
    // stale handler would otherwise queue an auto-retry the user did not ask for.
    clientGenerationRef.current += 1;
    if (autoRetryTimerRef.current) {
      clearTimeout(autoRetryTimerRef.current);
      autoRetryTimerRef.current = null;
    }
    clientRef.current?.disconnect();
    clientRef.current = null;
    historyLoadedForRef.current = null;
    setActiveGateway(null);
    setActiveHello(null);
    setActiveManifest(null);
    setStatus('disconnected');
    setMessages([]);
    setIsSending(false);
    setConnectionPhase('idle');
    void saveActiveGatewayId(null);
  }, []);

  const sendMessage = useCallback(
    async (text: string, existingMessageId?: string) => {
      const trimmed = text.trim();
      const gateway = activeGateway;
      const client = clientRef.current;
      if (!trimmed || !gateway || !client || isSending) return;

      if (existingMessageId) {
        setMessages((prev) =>
          prev.map((message) =>
            message.id === existingMessageId ? { ...message, queued: false } : message,
          ),
        );
      } else {
        const userMessage: ChatMessage = {
          id: createMessageId('user'),
          role: 'user',
          text: trimmed,
          timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, userMessage]);
      }
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
            .filter((m) => (m.role === 'user' || m.role === 'assistant') && !m.command && !m.queued && m.text.trim())
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
            onToolCall: (toolCall) => {
              setMessages((prev) => {
                const idx = prev.findIndex((m) => m.id === `run-${runId}`);
                if (idx < 0) return prev;
                const copy = [...prev];
                const existing = copy[idx].toolCalls ?? [];
                const match = existing.findIndex((item) => item.name === toolCall.name);
                const nextTools =
                  match >= 0
                    ? existing.map((item, i) => (i === match ? { ...item, ...toolCall } : item))
                    : [...existing, toolCall];
                copy[idx] = { ...copy[idx], toolCalls: nextTools, streaming: true };
                return copy;
              });
            },
          },
        );

        // Mark as complete
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === `run-${runId}`);
          if (idx < 0) return prev;
          const copy = [...prev];
          const tools = copy[idx].toolCalls?.map((tool) =>
            tool.status === 'running' ? { ...tool, status: 'complete' as const } : tool,
          );
          copy[idx] = { ...copy[idx], streaming: false, toolCalls: tools };
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
    [activeGateway, isSending, messages],
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
      onApprovalWaiting?: () => void,
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

      // Activity tracking: a provisional entry keyed by a local id until the
      // gateway returns the real run id (onStarted re-keys it).
      const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const startedAt = Date.now();
      const patchRun = (runId: string, patch: Partial<ActivityRun>) => {
        patchActivityRuns((prev) => prev.map((run) => (run.id === runId ? { ...run, ...patch } : run)));
      };
      patchActivityRuns((prev) => [
        { id: localId, prompt, status: 'running', startedAt, events: [] },
        ...prev,
      ]);
      const trackedId = { current: localId };

      try {
        const outcome = await executeRun(runCapable, prompt, {
          sessionId: sessionIdRef.current,
          model: gateway.model,
          signal: abortController.signal,
          onStarted: (runId) => {
            patchActivityRuns((prev) =>
              prev.map((run) => (run.id === trackedId.current ? { ...run, id: runId } : run)),
            );
            trackedId.current = runId;
          },
          onEvent: (event) => {
            const preview = runEventPreview(event);
            patchActivityRuns((prev) =>
              prev.map((run) =>
                run.id === trackedId.current
                  ? { ...run, events: [...run.events, { type: event.type, preview, timestamp: event.timestamp }].slice(-ACTIVITY_EVENT_CAP) }
                  : run,
              ),
            );
            onEvent?.({
              type: event.type,
              data: event.data,
              timestamp: event.timestamp,
            });
          },
          onApprovalRequired: (runId) => {
            patchRun(trackedId.current, { status: 'waiting-approval' });
            setPendingRunApproval({ runId, prompt });
            void notifyApprovalRequired(prompt);
            onApprovalWaiting?.();
            return new Promise<{ approved: boolean; feedback?: string }>((resolve) => {
              const onAbort = () => {
                runApprovalResolverRef.current = null;
                resolve({ approved: false });
              };
              runApprovalResolverRef.current = (approved: boolean, feedback?: string) => {
                patchRun(trackedId.current, { status: 'running', approved });
                abortController.signal.removeEventListener('abort', onAbort);
                resolve({ approved, feedback });
              };
              abortController.signal.addEventListener('abort', onAbort, { once: true });
            });
          },
        });

        const succeeded = /(complete|succeeded|success|done|finished)/i.test(outcome.status);
        patchRun(trackedId.current, {
          status: outcome.cancelled ? 'cancelled' : succeeded ? 'complete' : 'failed',
          summary: (outcome.error ?? outcome.result ?? outcome.status ?? '').slice(0, 160) || undefined,
          finishedAt: Date.now(),
        });

        if (!outcome.cancelled) {
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
    [patchActivityRuns, status],
  );

  const stopActivityRun = useCallback(
    (runId: string) => {
      const client = clientRef.current;
      // Abort the local driver (denies any pending approval, stops the stream).
      runAbortControllerRef.current?.abort();
      runAbortControllerRef.current = null;
      // Ask the gateway to stop the run server-side (best effort).
      if (client?.stopRun && !runId.startsWith('local-')) {
        void client.stopRun(runId).catch(() => undefined);
      }
      patchActivityRuns((prev) =>
        prev.map((run) =>
          run.id === runId && (run.status === 'running' || run.status === 'waiting-approval')
            ? { ...run, status: 'cancelled', finishedAt: Date.now() }
            : run,
        ),
      );
    },
    [patchActivityRuns],
  );

  const sendChatInput = useCallback(
    async (
      text: string,
      options?: { fromQueue?: boolean; messageId?: string },
    ) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const fromQueue = options?.fromQueue === true;
      const client = clientRef.current;

      if (!fromQueue && (!activeGateway || !client || status !== 'connected')) {
        queueOfflineInput(trimmed);
        return;
      }

      if (!isSlashCommandInput(trimmed)) {
        await sendMessage(trimmed, options?.messageId);
        return;
      }

      if (isCommandRunning) return;

      if (options?.messageId) {
        setMessages((prev) =>
          prev.map((message) =>
            message.id === options.messageId ? { ...message, queued: false } : message,
          ),
        );
      } else {
        appendLocalMessage('user', trimmed);
      }
      const commandLabel = readCommandLabel(trimmed);
      const matchingCmd = findConfirmableSlash(trimmed, dynamicCommands);
      const hasConfirmFlag = trimmed.includes('--confirm');

      const needsConfirmation =
        matchingCmd &&
        (matchingCmd.danger === 'write' || matchingCmd.danger === 'destructive') &&
        !hasConfirmFlag &&
        !confirmationBypassRef.current;

      if (needsConfirmation) {
        const preview = await buildActionPreview(trimmed, matchingCmd ?? null, commandLabel, gatewayRequest);
        setPendingConfirmation(preview);
        return;
      }

      commandStartTimeRef.current = Date.now();
      if (activeGateway) {
        void pushRecentCommand(activeGateway.id, trimmed).then(setRecentCommands);
      }
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
          currentModel: activeGateway?.model,
          gatewayRequest,
          runAgentCommand,
          methods: capabilitySnapshot.methods,
          dynamicCommands,
          runTask: (prompt, onEvent) =>
            runTask(prompt, onEvent, () => {
              streamedText = `${streamedText}\n⏳ Waiting for your approval…`.trim();
              updateLocalMessage(commandMessageId, {
                text: streamedText,
                command: { input: trimmed, title: commandLabel, status: 'running', ephemeral: true },
              });
            }),
          onAgentDelta: (delta) => {
            streamedText += delta;
            updateLocalMessage(commandMessageId, {
              text: streamedText,
              command: { input: trimmed, title: commandLabel, status: 'running', ephemeral: true },
            });
          },
          // Hermes/Gate: /model set updates the profile the same way the picker does.
          // OpenClaw keeps config.patch via the slash path when setModelOverride is omitted
          // only if we always pass this — so only wire for non-openclaw kinds.
          setModelOverride:
            activeGateway?.kind === 'openclaw'
              ? undefined
              : async (modelId) => {
                  const gateway = activeGatewayRef.current;
                  if (!gateway) return;
                  const updated = { ...gateway, model: modelId };
                  setActiveGateway(updated);
                  await upsertGateway(updated).then(setGateways);
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
      capabilitySnapshot.methods,
      dynamicCommands,
      gatewayRequest,
      isCommandRunning,
      runAgentCommand,
      runTask,
      sendMessage,
      status,
      updateLocalMessage,
      queueOfflineInput,
    ],
  );

  useEffect(() => {
    if (status !== 'connected' || isSending || isCommandRunning || flushingOfflineRef.current || offlineQueueRef.current.length === 0) {
      return;
    }

    const activeId = activeGatewayRef.current?.id;
    if (!activeId) return;

    // Only flush items destined for the active gateway.
    const forActive = offlineQueueRef.current.filter((item) => item.gatewayId === activeId || !item.gatewayId);
    const remainder = offlineQueueRef.current.filter((item) => item.gatewayId && item.gatewayId !== activeId);
    if (forActive.length === 0) return;

    flushingOfflineRef.current = true;
    offlineQueueRef.current = remainder;
    persistOfflineQueue();
    void (async () => {
      try {
        for (const item of forActive) {
          await sendChatInput(item.text, { fromQueue: true, messageId: item.id });
        }
      } catch {
        // Re-queue anything that did not clear so a kill mid-flush is not data loss.
      } finally {
        flushingOfflineRef.current = false;
      }
    })();
  }, [isCommandRunning, isSending, persistOfflineQueue, sendChatInput, status]);

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

  useEffect(() => {
    const gatewayId = activeGateway?.id;
    if (!gatewayId) return;
    let cancelled = false;
    void loadRecentCommands(gatewayId).then((commands) => {
      if (!cancelled) setRecentCommands(commands);
    });
    return () => {
      cancelled = true;
    };
  }, [activeGateway?.id]);

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
      if (!client) {
        if (activeGatewayRef.current) void reconnectLastKnownGateway();
        return;
      }

      if (client.connectionStatus !== 'connected') {
        client.resumeReconnect();
        return;
      }

      // We believe we are connected, but JS timers were frozen while
      // backgrounded — the last health sample may be arbitrarily old, and the
      // network may have changed underneath us. Verify before trusting it.
      void client.healthCheck(6000).then((health) => {
        if (!health && clientRef.current === client) void reconnectLastKnownGateway();
      });
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
      const known = await loadGateways();
      const parent = activeGateway.parentId
        ? known.find((item) => item.id === activeGateway.parentId)
        : undefined;
      const manifest = await fetchGatewayManifest(
        manifestUrlForGateway(activeGateway, parent?.url),
      ).catch(() => null);
      if (manifest) {
        setActiveManifest(manifest);
        if (!activeGateway.parentId) {
          const next = await syncChildProfiles(activeGateway, manifestProviders(manifest));
          if (next) setGateways(next);
        }
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
    (modelId: string, providerId?: string) => {
      closeModelPicker();
      if (activeGateway?.kind === 'openclaw') {
        // OpenClaw: model is gateway config — run the config command.
        void sendChatInput(`/model set ${modelId}`);
        return;
      }
      // Hermes: per-request model override (API server honors model per request).
      if (!activeGateway) return;
      const updated = { ...activeGateway, model: modelId, providerId: providerId ?? activeGateway.providerId };
      setActiveGateway(updated);
      void upsertGateway(updated).then(setGateways);
    },
    [activeGateway, closeModelPicker, sendChatInput],
  );

  const selectSession = useCallback((sessionId: string) => {
    closeSessionSelector();
    sessionIdRef.current = sessionId;
    clientRef.current?.setSessionId(sessionId);
    setCurrentSessionId(sessionId);
    if (activeGateway) {
      void reloadHistoryFor(activeGateway);
    }
  }, [closeSessionSelector, activeGateway, reloadHistoryFor]);

  const createNewSession = useCallback(async () => {
    const client = clientRef.current;
    if (!client?.createSession) return;
    try {
      const created = await client.createSession();
      sessionIdRef.current = created.id;
      setCurrentSessionId(created.id);
      setMessages([]);
      setSessionList((prev) => [created, ...prev]);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : String(error));
    }
    closeSessionSelector();
  }, [closeSessionSelector]);

  const deleteSessionById = useCallback(
    async (sessionId: string) => {
      const client = clientRef.current;
      if (!client?.deleteSession) return;
      try {
        await client.deleteSession(sessionId);
        setSessionList((prev) => prev.filter((session) => session.id !== sessionId));
        if (sessionIdRef.current === sessionId) {
          sessionIdRef.current = undefined;
          setCurrentSessionId(undefined);
          setMessages([]);
          if (activeGateway) void reloadHistoryFor(activeGateway);
        }
      } catch (error) {
        setLastError(error instanceof Error ? error.message : String(error));
      }
    },
    [activeGateway, reloadHistoryFor],
  );

  const deleteLocalMessage = useCallback(
    (id: string) => {
      setMessages((prev) => prev.filter((message) => message.id !== id));
      const before = offlineQueueRef.current.length;
      offlineQueueRef.current = offlineQueueRef.current.filter((item) => item.id !== id);
      if (offlineQueueRef.current.length !== before) persistOfflineQueue();
    },
    [persistOfflineQueue],
  );

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
      dynamicCommands,
      setupFromPcAddress,
      retryAutoConnect,
      completeOnboarding,
      setAutoConnect,
      transcripts,
      recentCommands,
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
      activityRuns,
      stopActivityRun,
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
      historyLoading,
      createNewSession,
      deleteSessionById,
      deleteLocalMessage,
    }),
    [
      gateways, activeGateway, activeHello, status, statusDetail, connectionPhase, probeMessage,
      messages, isSending, isCommandRunning, runningCommandLabel, lastError, deviceId, pairingDetails,
      settings, isBootstrapped, needsOnboarding, refreshGateways, addGateway, deleteGateway,
      connectGateway, disconnectGateway, sendMessage, sendChatInput, stopStreaming, reloadHistory,
      gatewayRequest, runAgentCommand, setupFromPcAddress, retryAutoConnect, completeOnboarding,
      setAutoConnect, transcripts, recentCommands, retryCommand, cancelCommand, capabilitySnapshot,
      refreshCapabilities, pendingConfirmation, confirmPendingAction, cancelPendingConfirmation,
      pendingRunApproval, resolveRunApproval, runTask, activityRuns, stopActivityRun, modelPicker, openModelPicker, closeModelPicker,
      selectModel, modelCatalog, sessionSelector,
      openSessionSelector, closeSessionSelector, selectSession, sessionList, currentSessionId,
      historyLoading, createNewSession, deleteSessionById, deleteLocalMessage,
      liveCapabilities, dynamicCommands,
    ],
  );

  return <GatewayContext.Provider value={value}>{children}</GatewayContext.Provider>;
}

export function useGateway() {
  const context = useContext(GatewayContext);
  if (!context) throw new Error('useGateway must be used within GatewayProvider');
  return context;
}
