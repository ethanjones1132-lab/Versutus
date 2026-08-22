import Constants from 'expo-constants';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';

import { GatewayDiscoveryScanner, isNativeDiscoveryAvailable } from '@/lib/discovery/scanner';
import { buildGatewayCandidates, friendlyPcName, normalizePcAddress } from '@/lib/gateway/candidates';
import { createClientForKind, type PortalClient } from '@/lib/portal/adapters';
import { decideConnectionPhase } from '@/lib/connection/phase';
import { abortAndClear } from '@/lib/gateway/abort';
import { serverSideCancelForCommand } from '@/lib/gateway/cancel';
import { isConnectionError, isUserAbort } from '@/lib/gateway/errors';
import {
  addStreamingPlaceholder,
  addUserMessage,
  appendStreamDelta,
  appendSystemNote,
  appendToolCallDelta,
  convertStreamError,
  finalizeStreamingMessage,
  interruptedRunIds,
  markInterrupted,
  preserveInterruptedAfterReload,
  settleInterruptedFromRuns,
} from '@/lib/gateway/message-reducer';
import {
  appendBounded,
  boundWindow,
  createMessageId,
  hasEarlierHistory,
  historyToChatMessages,
  pickAppSession,
  prependEarlier,
} from '@/lib/gateway/messages';
import { loadOrCreateDeviceIdentity } from '@/lib/gateway/device-identity';
import { loadBotChat, type PublicBot } from '@/lib/gateway/bots';
import { extractMentions, handoffFailedNote, rosterUnavailableNote } from '@/lib/gateway/mentions';
import { effectiveModel, resolveSendModel, withSelectedModel } from '@/lib/gateway/model-selection';
import {
  categorizeProbeError,
  GATEWAY_PROBE_PARALLEL_TIMEOUT_MS,
  GATEWAY_PROBE_TIMEOUT_MS,
  probeGatewayCandidates,
  probeGatewayUrl,
  probeHighPriorityCandidates,
} from '@/lib/gateway/probe';
import { isSlashCommandInput } from '@/lib/gateway/slash-commands';
import { findConfirmableSlash } from '@/lib/gateway/command-match';
import { GATEWAY_COMMANDS, buildCapabilitySnapshot } from '@/lib/gateway/dashboard';
import { manifestUrlForGateway } from '@/lib/gateway/gateway-origin';
import { loadRecentCommands, pushRecentCommand } from '@/lib/gateway/recents';
import {
  ACTIVITY_EVENT_CAP,
  executeRun,
  isTerminalRunStatus,
  outcomeToActivityStatus,
  runEventPreview,
  runStatusToActivityStatus,
  settleUnresolvedRuns,
  type ActivityRun,
  type RunCapableClient,
} from '@/lib/gateway/runs';
import {
  loadActivityRuns,
  loadOfflineQueue,
  saveActivityRuns,
  saveOfflineQueue,
  type OfflineQueueItem,
} from '@/lib/gateway/session-persistence';
import { syncChildProfiles } from '@/lib/gateway/child-sync';
import { checkTlsFingerprintTofu } from '@/lib/gateway/security';
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
  clearTranscriptsForGateway,
  loadTranscripts,
  updateTranscript,
} from '@/lib/gateway/transcript';
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
  /** Authenticated fetch for non-RPC gateway routes (CLI runs and their SSE stream). */
  gatewayFetch: (path: string, init?: RequestInit) => Promise<Response>;
  /** Native environments this gateway can converse through, if any. */
  backends: import('@/lib/portal/manifest').GatewayBackend[];
  selectedBackendId: string | undefined;
  /** Route chat and sessions through a different native environment. */
  selectBackend: (backendId: string | undefined) => void;
  selectedBotId: string | undefined;
  listBots: () => Promise<PublicBot[]>;
  createBot: (input: {
    name: string;
    soul?: string;
    inheritKeys?: boolean;
    description?: string;
    modelId?: string;
    providerId?: string;
  }) => Promise<PublicBot>;
  openBot: (botId: string) => Promise<void>;
  clearBot: () => void;
  botJobs: {
    list: () => Promise<{ id: string; name?: string; paused?: boolean }[]>;
    create: (input: { name: string; prompt: string; schedule: string }) => Promise<void>;
    run: (jobId: string) => Promise<void>;
    pause: (jobId: string, paused: boolean) => Promise<void>;
  };
  runAgentCommand: (command: string, options?: { onDelta?: (delta: string) => void }) => Promise<string>;
  dynamicCommands: GatewayCapabilityCommand[];
  deleteGateway: (id: string) => Promise<void>;
  connectGateway: (gateway: GatewayProfile) => Promise<void>;
  disconnectGateway: () => void;
  sendChatInput: (
    text: string,
    options?: { fromQueue?: boolean; messageId?: string },
  ) => Promise<void>;
  stopStreaming: () => Promise<void>;
  reloadHistory: () => Promise<void>;
  setupFromPcAddress: (pcAddress: string, token?: string) => Promise<boolean>;
  retryAutoConnect: () => Promise<void>;
  setAutoConnect: (enabled: boolean) => Promise<void>;
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
  tlsFingerprintChange: {
    previousFingerprint: string;
    observedFingerprint: string;
    gatewayName: string;
  } | null;
  approveTlsFingerprintChange: () => Promise<void>;
  rejectTlsFingerprintChange: () => void;
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
  createNewSession: (title?: string) => Promise<void>;
  /** Delete a session on the gateway (when the adapter supports it). */
  deleteSessionById: (sessionId: string) => Promise<void>;
  /** Remove a message from the local view (not propagated to the gateway). */
  deleteLocalMessage: (id: string) => void;
  /** Whether an earlier page of this session's history is likely available. */
  hasMoreHistory: boolean;
  /** True while a "load earlier" page fetch is in flight. */
  loadingEarlierHistory: boolean;
  /** Fetch and prepend the next page of older messages, deduped against what is shown. */
  loadEarlierMessages: () => Promise<void>;
};

/** Turns fetched per `reloadHistoryFor` call and per `loadEarlierMessages` page. */
const HISTORY_PAGE_SIZE = 80;

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
  // Request helpers consult this ref rather than rendered state. `status` is a
  // render value, so a request issued in the same tick as a connection change
  // reads whatever was captured at the last render — which throws "Gateway not
  // connected" on a live client, or lets a request through on a dead one.
  const statusRef = useRef<ConnectionStatus>('disconnected');
  const applyStatus = useCallback((next: ConnectionStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);
  const [statusDetail, setStatusDetail] = useState('');
  const [connectionPhase, setConnectionPhase] = useState<ConnectionPhase>('booting');
  // Kept in step synchronously (not via a useEffect, which lands a render
  // late) so decideConnectionPhase always sees the true current phase even
  // when two status events land in the same tick.
  const connectionPhaseRef = useRef<ConnectionPhase>('booting');
  const applyConnectionPhase = useCallback((next: ConnectionPhase) => {
    connectionPhaseRef.current = next;
    setConnectionPhase(next);
  }, []);
  const [probeMessage, setProbeMessage] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const messagesRef = useRef<ChatMessage[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  const [isSending, setIsSending] = useState(false);
  const [isCommandRunning, setIsCommandRunning] = useState(false);
  // Write-only: the label is tracked so a future running-command indicator can
  // read it, but nothing renders it today. Kept as state (not a ref) because
  // the setter is already threaded through the command paths.
  const [, setRunningCommandLabel] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [selectedBackendId, setSelectedBackendId] = useState<string | undefined>(undefined);
  const [selectedBotId, setSelectedBotId] = useState<string | undefined>(undefined);
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
  // Write-only: command transcripts are recorded but no surface renders them
  // yet. Removing the recording would lose the data a transcript view needs.
  const [, setTranscripts] = useState<CommandTranscriptEntry[]>([]);
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
        {
          backends: activeManifest?.backends ?? [],
          selectedBackendId,
          providers: activeManifest?.providers,
        },
      ),
    [status, activeHello, liveCapabilities, capabilityCheckedAt, capabilityInstances, activeManifest, selectedBackendId],
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
  const [loadingEarlierHistory, setLoadingEarlierHistory] = useState(false);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  // No offset/cursor on the history endpoint — "load earlier" re-fetches with
  // a bigger limit and diffs against what is already shown.
  const historyLimitRef = useRef(HISTORY_PAGE_SIZE);
  /** Oldest message id currently held, used as the `before` cursor. */
  const historyCursorRef = useRef<string | null>(null);
  const loadingEarlierRef = useRef(false);
  const confirmationBypassRef = useRef(false);
  const [recentCommands, setRecentCommands] = useState<string[]>([]);
  const [pendingRunApproval, setPendingRunApproval] = useState<{ runId: string; prompt: string } | null>(null);
  const [tlsFingerprintChange, setTlsFingerprintChange] = useState<{
    gateway: GatewayProfile;
    previousFingerprint: string;
    observedFingerprint: string;
  } | null>(null);
  const [activityRuns, setActivityRuns] = useState<ActivityRun[]>([]);
  const activityRunsRef = useRef<ActivityRun[]>([]);
  useEffect(() => {
    activityRunsRef.current = activityRuns;
  }, [activityRuns]);
  const runApprovalResolverRef = useRef<((approved: boolean, feedback?: string) => void) | null>(null);
  const runAbortControllerRef = useRef<AbortController | null>(null);
  const activeRunTaskIdRef = useRef<string | null>(null);
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
    // A fresh load starts a new page sequence for "load earlier".
    historyLimitRef.current = HISTORY_PAGE_SIZE;
    historyCursorRef.current = null;
    setHasMoreHistory(false);
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
           ? client.getSessionMessages(sessionId, historyLimitRef.current).catch(() => [])
           : Promise.resolve([]),
         loadTranscripts(gateway.id, sessionKey),
      ]);
      if (requestId !== historyRequestRef.current) return;
      setHasMoreHistory(hasEarlierHistory(gatewayHistory.length, historyLimitRef.current));
      // Seed the paging cursor from the oldest turn this page returned. A
      // gateway with no message ids leaves it null, which sends
      // loadEarlierMessages down the limit-growing fallback.
      historyCursorRef.current = gatewayHistory[0]?.id ?? null;
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

      setMessages(boundWindow(merged));
      setLastError(null);
    } catch (error) {
      if (requestId !== historyRequestRef.current) return;
      setLastError(error instanceof Error ? error.message : String(error));
    } finally {
      if (requestId === historyRequestRef.current) setHistoryLoading(false);
    }
  }, []);

  const loadEarlierMessages = useCallback(async () => {
    const client = clientRef.current;
    const sessionId = sessionIdRef.current;
    // Re-entrant taps and a request already superseded by a fresh reload both
    // no-op rather than racing a second page fetch against the first.
    if (!client || !sessionId || loadingEarlierRef.current) return;
    const requestId = historyRequestRef.current;
    loadingEarlierRef.current = true;
    setLoadingEarlierHistory(true);
    try {
      // Preferred path: ask for the page *before* the oldest turn we hold. Only
      // the new turns cross the wire, and paging is expressible past whatever
      // ceiling the gateway enforces on `limit`.
      const cursor = historyCursorRef.current;
      if (client.getSessionMessagePage && cursor) {
        const page = await client
          .getSessionMessagePage(sessionId, HISTORY_PAGE_SIZE, cursor)
          .catch(() => null);
        if (requestId !== historyRequestRef.current) return;

        // A gateway that reports paging settles it; one that does not falls
        // through to the short-page heuristic below.
        if (page && page.hasMore !== undefined) {
          historyCursorRef.current = page.nextBefore ?? null;
          setHasMoreHistory(page.hasMore && !!page.nextBefore);
          setMessages((prev) => prependEarlier(prev, historyToChatMessages(page.messages)));
          return;
        }
      }

      // Fallback for gateways with no cursor support: re-fetch a bigger window
      // and prepend only what it newly reveals.
      const nextLimit = historyLimitRef.current + HISTORY_PAGE_SIZE;
      const older = await client.getSessionMessages(sessionId, nextLimit).catch(() => []);
      if (requestId !== historyRequestRef.current) return;
      historyLimitRef.current = nextLimit;
      setHasMoreHistory(hasEarlierHistory(older.length, nextLimit));
      const olderChat = historyToChatMessages(older);
      setMessages((prev) => prependEarlier(prev, olderChat));
    } finally {
      loadingEarlierRef.current = false;
      setLoadingEarlierHistory(false);
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
            applyStatus(nextStatus);
            setStatusDetail(detail ?? '');

            const decision = decideConnectionPhase(connectionPhaseRef.current, nextStatus);
            applyConnectionPhase(decision.phase);
            if (decision.clearAutoRetryTimer && autoRetryTimerRef.current) {
              clearTimeout(autoRetryTimerRef.current);
              autoRetryTimerRef.current = null;
            }
            if (decision.clearGatewayDownNotified) gatewayDownNotifiedRef.current = false;
            if (decision.clearProbeMessage) setProbeMessage('');
            if (decision.clearLastError) setLastError(null);
            if (decision.notifyGatewayDown && !gatewayDownNotifiedRef.current) {
              gatewayDownNotifiedRef.current = true;
              void notifyGatewayDown(gatewayHostForDisplay(gateway.url));
            }
            if (decision.scheduleAutoRetry && activeGatewayRef.current && !authFailureRef.current) {
              scheduleAutoRetryRef.current(12000);
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
            if (!isCurrent()) return;
            const firstConnect = historyLoadedForRef.current !== gateway.id;
            if (firstConnect) {
              void reloadHistoryFor(gateway);
              return;
            }
            // Reconnect: freeze any still-streaming placeholder as interrupted,
            // reload history, and reconcile interrupted bubbles with authoritative
            // turns so a mid-stream disconnect does not leave a ghost message.
            const activeRunId = activeRunIdRef.current;
            if (activeRunId) {
              setMessages((prev) => markInterrupted(prev, activeRunId));
            }
            const previousMessages = messagesRef.current;
            void (async () => {
              await reloadHistoryFor(gateway);
              setMessages((history) => preserveInterruptedAfterReload(history, previousMessages));

              // Settle interrupted bubbles from their own run, not just from
              // history: a run that finished *after* the disconnect is often
              // absent from the history page just reloaded, which left the
              // bubble stuck as interrupted until a manual reload.
              const streamClient = clientRef.current;
              if (streamClient?.getRunStatus) {
                const pending = interruptedRunIds(messagesRef.current);
                if (pending.length > 0) {
                  const resolutions = await Promise.all(
                    pending.map(async (runId) => {
                      const result = await streamClient.getRunStatus!(runId).catch(() => null);
                      if (!result || !isTerminalRunStatus(result.status)) return null;
                      return {
                        runId,
                        text: result.result ?? result.error,
                        failed: runStatusToActivityStatus(result.status) === 'failed',
                      };
                    }),
                  );
                  const settled = resolutions.filter(
                    (item): item is NonNullable<typeof item> => item !== null,
                  );
                  if (settled.length > 0) {
                    setMessages((prev) => settleInterruptedFromRuns(prev, settled));
                  }
                }
              }

              // Settle any runs left unresolved by the disconnect.
              const client = clientRef.current;
              if (client?.getRunStatus) {
                const currentRuns = activityRunsRef.current;
                const unresolved = currentRuns.filter((run) => run.status === 'unresolved');
                if (unresolved.length > 0) {
                  const { runs: settled, changed } = await settleUnresolvedRuns(
                    client as unknown as RunCapableClient,
                    currentRuns,
                  );
                  if (changed.length > 0) {
                    patchActivityRuns(() => settled);
                    for (const run of changed) {
                      void notifyRunComplete(
                        run.status === 'complete' ? 'Run complete' : 'Run finished',
                        run.summary ?? run.status,
                      );
                    }
                  }
                }
              }
            })();
          },
          onError: (message) => {
            if (isCurrent()) setLastError(message);
          },
        },
        identityForClient,
      );
      // TLS fingerprint verify-on-first-use. A changed fingerprint blocks the
      // connection until the user explicitly approves it.
      const tofu = checkTlsFingerprintTofu(gateway, gateway.tlsFingerprint);
      if (tofu.kind === 'first-seen') {
        const updated = {
          ...gateway,
          tlsFingerprint: tofu.fingerprint,
          tlsFingerprintTrusted: true,
          tlsFingerprintFirstSeenAt: Date.now(),
        };
        gateway = updated;
        setActiveGateway(updated);
        void upsertGateway(updated).then(setGateways);
      } else if (tofu.kind === 'changed') {
        setTlsFingerprintChange({
          gateway,
          previousFingerprint: tofu.previousFingerprint,
          observedFingerprint: tofu.observedFingerprint,
        });
        return;
      }

      clientRef.current = client;
      historyLoadedForRef.current = null;
      applyConnectionPhase('connecting');
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
    // patchActivityRuns is a useCallback with [] deps, so its identity is stable
    // for the provider's lifetime; listing it satisfies exhaustive-deps without
    // changing when this callback is rebuilt.
    [reloadHistoryFor, applyStatus, applyConnectionPhase, patchActivityRuns],
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
      applyConnectionPhase('searching');
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
            const savedProbe = await probeGatewayUrl(saved.url, GATEWAY_PROBE_TIMEOUT_MS);
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
          probeResult = await probeHighPriorityCandidates(
            highPriorityUrls,
            setProbeMessage,
            GATEWAY_PROBE_PARALLEL_TIMEOUT_MS,
          );
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
            applyConnectionPhase('failed');
            setProbeMessage('Add your gateway address to connect.');
            scheduleAutoRetryRef.current(30000);
            return;
          }

          probeResult = await probeGatewayCandidates(candidates, setProbeMessage, GATEWAY_PROBE_TIMEOUT_MS);
        }

        if (!probeResult?.ok) {
          applyConnectionPhase('failed');
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
    [connectGateway, resolveGatewayForUrl, applyConnectionPhase],
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
        applyConnectionPhase('idle');
        return;
      }

      setNeedsOnboarding(false);

      void runAutoConnect(loadedSettings, loadedGateways, activeId).catch((error) => {
        applyConnectionPhase('failed');
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
      applyConnectionPhase('failed');
      setProbeMessage('Could not load saved gateway settings.');
      setLastError(error instanceof Error ? error.message : String(error));
      scheduleAutoRetryRef.current(30000);
    }
  }, [runAutoConnect, applyConnectionPhase]);

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
      if (!client || statusRef.current !== 'connected') throw new Error('Gateway not connected');
      return client.rpcRequest<T>(method, params);
    },
    [],
  );

  /**
   * Authenticated fetch against the connected gateway, for routes that are not
   * RPC — today the CLI run submission and its SSE event stream. Undefined when
   * the adapter has no such transport, so callers can degrade instead of guess.
   */
  const gatewayFetch = useCallback(
    async (path: string, init?: RequestInit) => {
      const client = clientRef.current;
      if (!client || statusRef.current !== 'connected') throw new Error('Gateway not connected');
      if (!client.authorizedFetch) {
        throw new Error('This gateway does not expose direct routes.');
      }
      return client.authorizedFetch(path, init);
    },
    [],
  );

  const backends = useMemo(() => activeManifest?.backends ?? [], [activeManifest]);

  /**
   * Switching backend switches the whole conversation context — sessions, models
   * and tools all belong to that environment — so the current session is
   * released and history reloads from the new one.
   */
  const selectBackend = useCallback(
    (backendId: string | undefined) => {
      const client = clientRef.current as (PortalClient & { setBackendId?: (id: string | undefined) => void }) | null;
      client?.setBackendId?.(backendId);
      client?.setBotId?.(undefined);
      setSelectedBackendId(backendId);
      setSelectedBotId(undefined);
      sessionIdRef.current = undefined;
      setCurrentSessionId(undefined);
      setMessages([]);
      if (activeGateway) {
        // Restore the model last used in this backend, so a send after the
        // switch does not carry the previous backend's model id.
        const restored = effectiveModel(activeGateway, backendId);
        if (restored && restored !== activeGateway.model) {
          const updated = { ...activeGateway, model: restored };
          setActiveGateway(updated);
          void upsertGateway(updated).then(setGateways);
        }
        void reloadHistoryFor(activeGateway);
      }
    },
    [activeGateway, reloadHistoryFor],
  );

  const runAgentCommand = useCallback(
    async (command: string, options?: { onDelta?: (delta: string) => void }) => {
      const gateway = activeGateway;
      const client = clientRef.current;
      const trimmed = command.trim();
      // Pre-flight guard: a stale read only declines a retryable action.
      // Converting to statusRef or the connection reducer needs live-device
      // verification because it changes when this effect/callback re-runs.
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
          ...resolveSendModel(gateway, selectedBackendId, selectedBotId),
          providerId: selectedBotId ? undefined : gateway.providerId,
        },
      );
      return fullText;
    },
    [activeGateway, status, selectedBackendId, selectedBotId],
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
    setMessages((prev) => appendBounded(prev, msg));

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
    const before = gateways;
    const next = await removeGateway(id);
    setGateways(next);

    // Transcripts are keyed by gateway id and outlive the profile otherwise.
    // The cascade can take child profiles with it, so clear everything that
    // disappeared rather than only the id we were handed.
    const removedIds = new Set<string>([id]);
    for (const gateway of before) {
      if (!next.some((remaining) => remaining.id === gateway.id)) removedIds.add(gateway.id);
    }
    await Promise.all([...removedIds].map((removedId) => clearTranscriptsForGateway(removedId)));

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
      applyStatus('disconnected');
      setMessages([]);
      await saveActiveGatewayId(null);
      if (settings.autoConnect && next.length > 0) {
        applyConnectionPhase('searching');
        setProbeMessage('Searching for another gateway…');
        void runAutoConnect(settings, next, null);
      } else {
        applyConnectionPhase('idle');
      }
    }
  }, [activeGateway, gateways, settings, runAutoConnect, applyStatus, applyConnectionPhase]);

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
    applyStatus('disconnected');
    setMessages([]);
    setIsSending(false);
    applyConnectionPhase('idle');
    void saveActiveGatewayId(null);
  }, [applyStatus, applyConnectionPhase]);

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
        setMessages((prev) => addUserMessage(prev, trimmed));
      }
      setIsSending(true);
      setLastError(null);

      const runId = createMessageId('run');
      activeRunIdRef.current = runId;

      // Add streaming placeholder
      setMessages((prev) => addStreamingPlaceholder(prev, runId));

      // Declared outside the try so the catch can ask the signal itself
      // whether this failure was the user cancelling.
      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      try {
        // Build bounded conversation context: last 20 real turns, no command payloads.
        const conversationMessages = [
          ...messages
            .filter((m) => (m.role === 'user' || m.role === 'assistant') && !m.command && !m.queued && m.text.trim())
            .slice(-20)
            .map((m) => ({ role: m.role, content: m.text })),
          { role: 'user', content: trimmed },
        ];

        await client.streamChat(
          conversationMessages,
          (delta) => {
            setMessages((prev) => appendStreamDelta(prev, runId, delta));
          },
          {
            sessionId: sessionIdRef.current,
            ...resolveSendModel(gateway, selectedBackendId, selectedBotId),
            providerId: selectedBotId ? undefined : gateway.providerId,
            signal: abortController.signal,
            onToolCall: (toolCall) => {
              setMessages((prev) => appendToolCallDelta(prev, runId, toolCall));
            },
          },
        );

        // Mark as complete
        setMessages((prev) => finalizeStreamingMessage(prev, runId));
        setLastError(null);
        // Bot-to-bot handoff after a successful reply: deliver @mentions of
        // other bots on the roster. Failures here used to be swallowed — the
        // user believed the other bot received the handoff when it did not.
        // Every failure now surfaces as a system note in the thread.
        if (selectedBotId && client.handoffMention && client.listBots) {
          let roster: PublicBot[] = [];
          let rosterLoaded = true;
          try {
            roster = await client.listBots();
          } catch (error) {
            rosterLoaded = false;
            const detail = error instanceof Error ? error.message : String(error);
            setMessages((prev) => appendSystemNote(prev, rosterUnavailableNote(detail)));
          }
          if (rosterLoaded) {
            const mentions = extractMentions(trimmed, roster.map((bot) => bot.id)).filter(
              (id) => id !== selectedBotId,
            );
            for (const toId of mentions) {
              try {
                await client.handoffMention({ fromId: selectedBotId, toId, text: trimmed });
              } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                setMessages((prev) => appendSystemNote(prev, handoffFailedNote(toId, detail)));
              }
            }
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const aborted = isUserAbort(error, abortController.signal);
        if (aborted) {
          setMessages((prev) => convertStreamError(prev, runId, message, true));
        } else if (isConnectionError(error)) {
          setMessages((prev) => markInterrupted(prev, runId));
          setLastError(message);
        } else {
          setMessages((prev) => convertStreamError(prev, runId, message, false));
          setLastError(message);
        }
      } finally {
        setIsSending(false);
        activeRunIdRef.current = null;
        abortControllerRef.current = null;
      }
    },
    [activeGateway, isSending, messages, selectedBackendId, selectedBotId],
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
      // Pre-flight guard: a stale read only declines a retryable action.
      // Converting to statusRef or the connection reducer needs live-device
      // verification because it changes when this effect/callback re-runs.
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
            activeRunTaskIdRef.current = runId;
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

        patchRun(trackedId.current, {
          status: outcomeToActivityStatus(outcome),
          summary: (outcome.error ?? outcome.result ?? outcome.status ?? '').slice(0, 160) || undefined,
          finishedAt: Date.now(),
        });

        if (!outcome.cancelled) {
          const summary = (outcome.error ?? outcome.result ?? outcome.status ?? '').slice(0, 120);
          const status = outcomeToActivityStatus(outcome);
          void notifyRunComplete(
            status === 'complete'
              ? 'Run complete'
              : status === 'unresolved'
                ? 'Run unconfirmed'
                : 'Run finished',
            summary || outcome.status,
          );
        }
        return outcome;
      } finally {
        runAbortControllerRef.current = null;
        activeRunTaskIdRef.current = null;
      }
    },
    [patchActivityRuns, status],
  );

  const stopActivityRun = useCallback(
    (runId: string) => {
      // Abort the local driver (denies any pending approval, stops the stream).
      abortAndClear(runAbortControllerRef);
      // Ask the gateway to stop the run server-side (best effort).
      void serverSideCancelForCommand(clientRef.current, runId);
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

      // Pre-flight guard: a stale read only declines a retryable action.
      // Converting to statusRef or the connection reducer needs live-device
      // verification because it changes when this effect/callback re-runs.
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
        if (!client || statusRef.current !== 'connected') throw new Error('Gateway not connected');

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
    // Pre-flight guard: a stale read only pauses a retryable flush.
    // Converting to statusRef or the connection reducer needs live-device
    // verification because it changes when this effect re-runs.
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
    abortAndClear(abortControllerRef);
    // Abort an in-flight agentic run (denies any pending approval).
    abortAndClear(runAbortControllerRef);

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

      applyConnectionPhase('searching');

      let probeResult = await probeHighPriorityCandidates(
        candidates,
        setProbeMessage,
        GATEWAY_PROBE_PARALLEL_TIMEOUT_MS,
      );

      if (!probeResult?.ok) {
        probeResult = await probeGatewayCandidates(
          candidates.slice(3),
          setProbeMessage,
          GATEWAY_PROBE_TIMEOUT_MS,
        );
      }
      if (!probeResult?.ok) {
        applyConnectionPhase('failed');
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
    [connectGateway, gateways, resolveGatewayForUrl, applyConnectionPhase],
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
    const probe = await probeGatewayUrl(active.url, GATEWAY_PROBE_TIMEOUT_MS);
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

  const setAutoConnect = useCallback(async (enabled: boolean) => {
    const next = await saveAppSettings({ autoConnect: enabled });
    setSettings(next);
  }, []);

  const retryCommand = useCallback((entry: Partial<CommandTranscriptEntry> & { input: string }) => {
    if (!entry.input) return;
    void sendChatInput(entry.input);
  }, [sendChatInput]);

  const cancelCommand = useCallback((id: string) => {
    // Cancelling has to actually stop the work. Without this the transcript
    // reads "cancelled" while the gateway keeps running, and its completion
    // then re-updates the very message the user cancelled.
    abortAndClear(abortControllerRef);
    abortAndClear(runAbortControllerRef);

    // Best-effort server-side stop for agentic runs. Chat streams are stopped
    // by the abort signal above (adapters listen to it and call session.abort).
    void serverSideCancelForCommand(clientRef.current, activeRunTaskIdRef.current);

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

  const approveTlsFingerprintChange = useCallback(async () => {
    if (!tlsFingerprintChange) return;
    const { gateway, observedFingerprint } = tlsFingerprintChange;
    const updated = {
      ...gateway,
      tlsFingerprint: observedFingerprint,
      tlsFingerprintTrusted: true,
      tlsFingerprintFirstSeenAt: Date.now(),
    };
    setTlsFingerprintChange(null);
    setActiveGateway(updated);
    const next = await upsertGateway(updated);
    setGateways(next);
    await attachClient(updated);
  }, [tlsFingerprintChange, attachClient]);

  const rejectTlsFingerprintChange = useCallback(() => {
    setTlsFingerprintChange(null);
    disconnectGateway();
  }, [disconnectGateway]);

  const refreshCapabilities = useCallback(async () => {
    if (!activeGateway) return;
    try {
      const client = clientRef.current;
      // Pre-flight guard: a stale read only skips a retryable refresh.
      // Converting to statusRef or the connection reducer needs live-device
      // verification because it changes when this effect/callback re-runs.
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
      const updated = selectedBotId
        ? withSelectedModel(activeGateway, modelId, selectedBackendId, selectedBotId)
        : {
            ...withSelectedModel(activeGateway, modelId, selectedBackendId),
            providerId: providerId ?? activeGateway.providerId,
          };
      setActiveGateway(updated);
      void upsertGateway(updated).then(setGateways);
    },
    [activeGateway, closeModelPicker, sendChatInput, selectedBackendId, selectedBotId],
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

  const listBots = useCallback(async (): Promise<PublicBot[]> => {
    const client = clientRef.current;
    if (!client?.listBots) return [];
    return client.listBots();
  }, []);

  const botJobs = useMemo(() => ({
    list: async () => {
      const client = clientRef.current;
      if (!client?.listJobs) return [];
      return client.listJobs();
    },
    create: async (input: { name: string; prompt: string; schedule: string }) => {
      const client = clientRef.current;
      if (!client?.createJob) throw new Error('This gateway does not manage jobs.');
      await client.createJob(input);
    },
    run: async (jobId: string) => {
      const client = clientRef.current;
      if (!client?.runJob) throw new Error('This gateway does not run jobs.');
      await client.runJob(jobId);
    },
    pause: async (jobId: string, paused: boolean) => {
      const client = clientRef.current;
      if (!client?.setJobPaused) throw new Error('This gateway does not pause jobs.');
      await client.setJobPaused(jobId, paused);
    },
  }), []);

  const createBot = useCallback(async (input: {
    name: string;
    soul?: string;
    inheritKeys?: boolean;
    description?: string;
    modelId?: string;
    providerId?: string;
  }): Promise<PublicBot> => {
    const client = clientRef.current;
    if (!client?.createBot) {
      throw new Error('This gateway does not create bots.');
    }
    return client.createBot(input);
  }, []);

  const clearBot = useCallback(() => {
    clientRef.current?.setBotId?.(undefined);
    setSelectedBotId(undefined);
  }, []);

  const openBot = useCallback(async (botId: string) => {
    const client = clientRef.current;
    if (!client?.setBotId || !client.createSession) {
      setLastError('This gateway does not expose bots.');
      return;
    }
    client.setBotId(botId);
    setSelectedBotId(botId);
    try {
      const chat = await loadBotChat(
        () => client.getSessions(200),
        (title) => client.createSession!(title),
      );
      sessionIdRef.current = chat.id;
      client.setSessionId(chat.id);
      setCurrentSessionId(chat.id);
      setSessionList((prev) => (prev.some((session) => session.id === chat.id) ? prev : [chat, ...prev]));
      if (activeGateway) void reloadHistoryFor(activeGateway);
    } catch (error) {
      client.setBotId(undefined);
      setSelectedBotId(undefined);
      setLastError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }, [activeGateway, reloadHistoryFor]);

  const createNewSession = useCallback(async (title?: string) => {
    const client = clientRef.current;
    if (!client?.createSession) return;
    try {
      const created = await client.createSession(title);
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
      sendChatInput,
      stopStreaming,
      reloadHistory,
      gatewayRequest,
      gatewayFetch,
      backends,
      selectedBackendId,
      selectBackend,
      selectedBotId,
      listBots,
      createBot,
      openBot,
      clearBot,
      botJobs,
      runAgentCommand,
      dynamicCommands,
      setupFromPcAddress,
      retryAutoConnect,
      setAutoConnect,
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
      tlsFingerprintChange: tlsFingerprintChange
        ? {
            previousFingerprint: tlsFingerprintChange.previousFingerprint,
            observedFingerprint: tlsFingerprintChange.observedFingerprint,
            gatewayName: tlsFingerprintChange.gateway.name,
          }
        : null,
      approveTlsFingerprintChange,
      rejectTlsFingerprintChange,
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
      hasMoreHistory,
      loadingEarlierHistory,
      loadEarlierMessages,
    }),
    [
      gateways, activeGateway, activeHello, status, statusDetail, connectionPhase, probeMessage,
      messages, isSending, isCommandRunning, lastError, deviceId, pairingDetails,
      settings, isBootstrapped, needsOnboarding, refreshGateways, addGateway, deleteGateway,
      connectGateway, disconnectGateway, sendChatInput, stopStreaming, reloadHistory,
      gatewayRequest, gatewayFetch, backends, selectedBackendId, selectBackend, selectedBotId, listBots, createBot, openBot, clearBot, botJobs, runAgentCommand, setupFromPcAddress, retryAutoConnect,
      setAutoConnect, recentCommands, retryCommand, cancelCommand, capabilitySnapshot,
      refreshCapabilities, pendingConfirmation, confirmPendingAction, cancelPendingConfirmation,
      pendingRunApproval, resolveRunApproval,
      approveTlsFingerprintChange,
      rejectTlsFingerprintChange,
      runTask, activityRuns, stopActivityRun, modelPicker, openModelPicker, closeModelPicker,
      selectModel, modelCatalog, sessionSelector,
      openSessionSelector, closeSessionSelector, selectSession, sessionList, currentSessionId,
      historyLoading, createNewSession, deleteSessionById, deleteLocalMessage,
      tlsFingerprintChange,
      dynamicCommands,
      hasMoreHistory, loadingEarlierHistory, loadEarlierMessages,
    ],
  );

  return <GatewayContext.Provider value={value}>{children}</GatewayContext.Provider>;
}

export function useGateway() {
  const context = useContext(GatewayContext);
  if (!context) throw new Error('useGateway must be used within GatewayProvider');
  return context;
}
