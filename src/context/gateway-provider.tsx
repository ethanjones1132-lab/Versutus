import Constants from 'expo-constants';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';

import { GatewayDiscoveryScanner, isNativeDiscoveryAvailable } from '@/lib/discovery/scanner';
import { beaconKindForUrl, buildExplicitHostCandidates, buildGatewayCandidates, friendlyPcName, normalizePcAddress } from '@/lib/gateway/candidates';
import { createClientForKind, type PortalClient } from '@/lib/portal/adapters';
import { decideConnectionPhase } from '@/lib/connection/phase';
import {
  AUTO_RETRY_BASE_DELAY_MS,
  autoRetryDelayMs,
  autoRetryPulse,
  type AutoRetryPulse,
} from '@/lib/connection/retry-ladder';
import { abortAndClear } from '@/lib/gateway/abort';
import { serverSideCancelForCommand } from '@/lib/gateway/cancel';
import { isConnectionError, isUserAbort } from '@/lib/gateway/errors';
import {
  addStreamingPlaceholder,
  addUserMessage,
  appendSystemNote,
  convertStreamError,
  finalizeStreamingMessage,
  interruptedRunIds,
  markInterrupted,
  preserveInterruptedAfterReload,
  settleInterruptedFromRuns,
} from '@/lib/gateway/message-reducer';
import { createStreamBatcher } from '@/lib/gateway/stream-batching';
import { readHistory } from '@/lib/gateway/history-read';
import {
  appendBounded,
  boundWindow,
  createMessageId,
  hasEarlierHistory,
  historyToChatMessages,
  prependEarlier,
} from '@/lib/gateway/messages';
import { liveSessionId, pinLiveSession, resolveResumeSession } from '@/lib/gateway/session-resume';
import { threadSwitchFailureText, validateThreadSwitch } from '@/lib/gateway/thread-switch';
import {
  applySessionListRead,
  beginSessionListRead,
  emptySessionList,
  nextSessionListLimit,
  sessionListCopy,
  sessionListMayHaveOlder,
  SESSION_LIST_PAGE_SIZE,
  type SessionListState,
} from '@/lib/gateway/session-list';
import { loadOrCreateDeviceIdentity } from '@/lib/gateway/device-identity';
import {
  hasBotManagement as probeBotManagement,
  loadBotChat,
  type PublicBot,
} from '@/lib/gateway/bots';
import { onboardingCompletionForAddedGateway } from '@/lib/onboarding/completion-from-add';
import {
  hasGroupRooms as probeGroupRooms,
  type BotGroupRoom,
  type GroupReply,
  type GroupTranscriptEntry,
} from '@/lib/gateway/groups';
import { extractMentions, handoffFailedNote, rosterUnavailableNote } from '@/lib/gateway/mentions';
import { formatRunFailure, modelSubstitutionNote, shouldShowModelSubstitution } from '@/lib/gateway/run-failures';
import { resolveDefaultBackend } from '@/lib/gateway/backend-defaults';
import {
  decideEnvironmentProbe,
  environmentProbeFailureText,
  probeEnvironmentLifecycle,
} from '@/lib/gateway/environment-probe';
import { applyModelOverride, effectiveModel, modelSwitchAnnouncement, resolveSendModel, shouldReleaseSessionForModel, staleModelPin, withSelectedModel } from '@/lib/gateway/model-selection';
import {
  buildEarlyProbeUrls,
  dropAlreadyWavedCandidates,
  mergeDiscoveredProbeUrls,
  sameGatewayUrl,
} from '@/lib/gateway/auto-connect-candidates';
import {
  categorizeProbeError,
  GATEWAY_PROBE_PARALLEL_TIMEOUT_MS,
  GATEWAY_PROBE_TIMEOUT_MS,
  HIGH_PRIORITY_WAVE_SIZE,
  probeGatewayCandidates,
  probeGatewayUrl,
  probeHighPriorityCandidates,
} from '@/lib/gateway/probe';
import { isSlashCommandInput, shouldPassthroughSkillSlash } from '@/lib/gateway/slash-commands';
import { decideBusySlash } from '@/lib/gateway/busy-slash';
import type { Skill } from '@/lib/gateway/skills';
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
import {
  dismissGatewayDown,
  notifyApprovalRequired,
  notifyGatewayDown,
  notifyRunComplete,
} from '@/lib/notifications/local';
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
  RunEvent,
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
  lastError: string | null;
  /** Clear the banner. The surface showing an error owns dismissing it. */
  clearLastError: () => void;
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
  /**
   * The connected Gate's manifest (name, kind, version, vendor, capability
   * flags), when it reported one. Read-only — screens render it, nobody
   * refetches through it.
   */
  activeManifest: import('@/lib/portal/manifest').GatewayManifest | null;
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
  /** Edit an existing Bot's soul, description or model pin; null clears a pin — Gate adapters only. */
  updateBot: (input: {
    id: string;
    soul?: string;
    description?: string;
    modelId?: string | null;
    providerId?: string | null;
  }) => Promise<PublicBot>;
  /** Whether this gateway can create and edit Bots at all — creation affordances gate on it. */
  hasBotManagement: boolean;
  /** Whether this gateway hosts Gate-owned group rooms at all — room creation gates on it. */
  hasGroupRooms: boolean;
  openBot: (botId: string) => Promise<void>;
  clearBot: () => void;
  botJobs: {
    list: () => Promise<{ id: string; name?: string; paused?: boolean }[]>;
    create: (input: { name: string; prompt: string; schedule: string }) => Promise<void>;
    run: (jobId: string) => Promise<void>;
    pause: (jobId: string, paused: boolean) => Promise<void>;
    remove: (jobId: string) => Promise<void>;
  };
  /**
   * Cron transparency, read-only. `available` is false on a gateway whose
   * client cannot join jobs to their runs — the Activity section then does not
   * render at all, rather than showing an empty list that reads as "no
   * scheduled work" on a host that has plenty.
   */
  cron: {
    available: boolean;
    list: () => Promise<import('@/lib/gateway/cron').CronJob[]>;
    runs: (jobId: string) => Promise<import('@/lib/gateway/cron').CronRun[]>;
    transcript: (runId: string, limit?: number) => Promise<import('@/lib/gateway/cron').CronTurn[]>;
  };
  botGroups: {
    list: () => Promise<BotGroupRoom[]>;
    create: (input: { name: string; memberIds: string[] }) => Promise<BotGroupRoom>;
    send: (
      groupId: string,
      input: { text: string; mentionedIds?: string[] },
    ) => Promise<{ replies: GroupReply[] }>;
    history: (groupId: string) => Promise<GroupTranscriptEntry[]>;
    rename: (groupId: string, name: string) => Promise<BotGroupRoom>;
    leave: (groupId: string, memberId: string) => Promise<BotGroupRoom>;
    deleteGroup: (groupId: string) => Promise<{ ok: boolean }>;
    addMembers: (groupId: string, memberIds: string[]) => Promise<BotGroupRoom>;
  };
  runAgentCommand: (command: string, options?: { onDelta?: (delta: string) => void }) => Promise<string>;
  dynamicCommands: GatewayCapabilityCommand[];
  deleteGateway: (id: string) => Promise<void>;
  connectGateway: (gateway: GatewayProfile) => Promise<void>;
  disconnectGateway: () => void;
  sendChatInput: (
    text: string,
    options?: { fromQueue?: boolean; messageId?: string; skills?: Skill[] },
  ) => Promise<void>;
  stopStreaming: () => Promise<void>;
  reloadHistory: () => Promise<void>;
  setupFromPcAddress: (pcAddress: string, token?: string) => Promise<boolean>;
  retryAutoConnect: () => Promise<void>;
  /** A pending automatic cool-down retry, or null when none is scheduled. */
  autoRetry: AutoRetryPulse | null;
  setAutoConnect: (enabled: boolean) => Promise<void>;
  recentCommands: string[];
  /** Slash-command executions held for this gateway + session (display-only). */
  commandTranscripts: CommandTranscriptEntry[];
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
  /**
   * Drain a run's full event stream from the gateway and resolve with the
   * collected list. Used by the agentic-run transcript sheet; aborting the
   * signal stops the collection and lets the SSE reader release the response.
   */
  loadRunEvents: (runId: string, signal: AbortSignal) => Promise<RunEvent[]>;
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
  /** Set when the last session-list read failed. Empty is not the same fact. */
  sessionListError?: string;
  /** True once a session read has landed. Empty before it is not "no sessions". */
  sessionListLoaded: boolean;
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
  /** True when the last selector read filled its window — older threads may exist. */
  sessionListHasOlder: boolean;
  /** True while a "show older" widened read is in flight. */
  loadingOlderSessions: boolean;
  /** Re-read the selector window one page wider so older threads appear. */
  loadOlderSessions: () => Promise<void>;
};

/** Turns fetched per `reloadHistoryFor` call and per `loadEarlierMessages` page. */
const HISTORY_PAGE_SIZE = 80;

/**
 * Transcript and send state, split out of the shared gateway value so a
 * streamed frame re-renders only the chat surface that reads them instead
 * of the whole mounted tab tree.
 */
type ChatSurfaceContextValue = {
  messages: ChatMessage[];
  isSending: boolean;
  isCommandRunning: boolean;
};

const ChatSurfaceContext = createContext<ChatSurfaceContextValue | null>(null);
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
  const createNewSessionRef = useRef<(title?: string) => Promise<void>>(async () => undefined);
  const selectSessionRef = useRef<(sessionId: string) => void>(() => undefined);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  const [isSending, setIsSending] = useState(false);
  const [isCommandRunning, setIsCommandRunning] = useState(false);
  // Tracks the running command's label so a second slash command can be told
  // which command it must wait for. Kept as state (not a ref) because the
  // setter is already threaded through the command paths.
  const [runningCommandLabel, setRunningCommandLabel] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const clearLastError = useCallback(() => setLastError(null), []);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [selectedBackendId, setSelectedBackendId] = useState<string | undefined>(undefined);
  const [selectedBotId, setSelectedBotId] = useState<string | undefined>(undefined);
  // Mirrored so long-lived callbacks (reloadHistoryFor and friends) can read
  // the current scope without taking it as a dependency — the same reason
  // activeGatewayRef exists. Rebuilding those callbacks on every backend or
  // Bot switch would re-run the effects that depend on their identity.
  const selectedBackendIdRef = useRef<string | undefined>(undefined);
  const selectedBotIdRef = useRef<string | undefined>(undefined);
  // Id already probed for this activation. Cleared when backends disappear
  // so a reconnect re-probes the same backend once, not on every render.
  const lastProbedBackendRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    selectedBackendIdRef.current = selectedBackendId;
  }, [selectedBackendId]);
  useEffect(() => {
    selectedBotIdRef.current = selectedBotId;
  }, [selectedBotId]);
  // Client-derived honesty verdicts, decided when a client is installed and
  // cleared when it goes away: does this client speak bots / group rooms at
  // all? The pure decisions live in lib/gateway so the UI hides creation
  // affordances instead of refusing after the operator fills the sheet.
  const [hasBotManagement, setHasBotManagement] = useState(false);
  const [hasGroupRooms, setHasGroupRooms] = useState(false);
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
  // Command transcripts are recorded here and rendered read-only by the
  // chat overflow sheet's command-history section.
  const [commandTranscripts, setTranscripts] = useState<CommandTranscriptEntry[]>([]);
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
  const [sessionListState, setSessionListState] = useState<SessionListState<HermesSession>>(
    emptySessionList<HermesSession>(),
  );
  const [sessionSelector, setSessionSelector] = useState<{ visible: boolean }>({ visible: false });
  // No offset/cursor on the session endpoints — "show older" re-reads with a
  // wider limit, the same pattern history uses for "load earlier".
  /** Newest open wins: a superseded read must not overwrite a fresher one. */
  const sessionReadSeqRef = useRef(0);
  const modelReadSeqRef = useRef(0);
  const sessionListLimitRef = useRef(SESSION_LIST_PAGE_SIZE);
  const [sessionListHasOlder, setSessionListHasOlder] = useState(false);
  const [loadingOlderSessions, setLoadingOlderSessions] = useState(false);
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
  const lastSubstitutionRef = useRef<import('@/lib/gateway/run-failures').ModelReport | null>(null);
  const sessionIdRef = useRef<string | undefined>(undefined);
  const bootstrapStartedRef = useRef(false);
  const autoConnectInFlightRef = useRef(false);
  const autoRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Mirrors any PENDING automatic retry so the UI can show what is waiting. */
  const [autoRetry, setAutoRetry] = useState<AutoRetryPulse | null>(null);
  /** Consecutive failed auto-retries without an intervening success — drives the cool-down ladder. */
  const autoRetryFailureStreakRef = useRef(0);
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
      // A deliberate session switch updates the ref; a deliberate release
      // (CLI environment switch) clears it. Stored is a reconnect pin, not
      // a live thread — using it as a fallback resurrected the previous
      // environment's session after selectBackend had just let it go.
      let sessionId = liveSessionId({
        live: sessionIdRef.current,
        stored: gateway.sessionId,
      });

      // Resume this app's own most recent session, or start a fresh one. The
      // session selector still lists every session for deliberate switching.
      // A gate that cannot manage sessions (no `/v1/sessions` endpoint in its
      // manifest) degrades to stateless chat instead of failing the whole
      // reload — an operator connecting to such a gate still gets the
      // dashboard and every environment run.
      if (!sessionId) {
        // Same reason as createNewSession: if this connect has to open a
        // session, it must be born with the operator's model already on it.
        const outcome = await resolveResumeSession(
          client,
          effectiveModel(gateway, selectedBackendIdRef.current, selectedBotIdRef.current),
        );
        if (requestId === historyRequestRef.current) {
          setSessionListState((previous) => ({ ...previous, sessions: outcome.sessions }));
        }
        sessionId = outcome.sessionId;
      }

      // Only the newest reload may claim the live thread. Cold start races
      // the connect health-check reload against the adopt-backend reload;
      // the older one can finish last after resolving against a scope a
      // newer reload already replaced. Pinning it would point the next
      // send at a session the UI is not showing — an unscoped list
      // resolves to whichever environment the Gate picks, claude-local
      // here, and that session's model pin is immutable.
      if (requestId === historyRequestRef.current) {
        sessionIdRef.current = sessionId;
        setCurrentSessionId(sessionId);
      }

      const sessionKey = gateway.sessionKey ?? sessionId ?? 'default';
      const [historyRead, localTrans] = await Promise.all([
        sessionId
          ? readHistory(() => client.getSessionMessages(sessionId, historyLimitRef.current), [])
          : Promise.resolve({ ok: true as const, value: [] }),
        loadTranscripts(gateway.id, sessionKey),
      ]);
      if (requestId !== historyRequestRef.current) return;
      if (!historyRead.ok) {
        setLastError(`Session history could not be read: ${historyRead.error}`);
        return;
      }
      const gatewayHistory = historyRead.value;
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
        const pageRead = await readHistory(
          () => client.getSessionMessagePage!(sessionId, HISTORY_PAGE_SIZE, cursor),
          { messages: [] },
        );
        if (requestId !== historyRequestRef.current) return;
        if (!pageRead.ok) {
          setLastError(`Session history could not be read: ${pageRead.error}`);
          return;
        }
        const page = pageRead.value;

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
      const olderRead = await readHistory(() => client.getSessionMessages(sessionId, nextLimit), []);
      if (requestId !== historyRequestRef.current) return;
      if (!olderRead.ok) {
        setLastError(`Session history could not be read: ${olderRead.error}`);
        return;
      }
      const older = olderRead.value;
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
            if (decision.clearAutoRetryTimer) {
              if (autoRetryTimerRef.current) {
                clearTimeout(autoRetryTimerRef.current);
                autoRetryTimerRef.current = null;
                setAutoRetry(null);
              }
              // Connected again: the failure streak that led here is forgiven.
              autoRetryFailureStreakRef.current = 0;
            }
            if (decision.clearGatewayDownNotified) {
              gatewayDownNotifiedRef.current = false;
              // Connected again: this gateway's posted down notice retires
              // itself instead of haunting the tray long after the gateway
              // answered — scoped to the gateway that actually answered, so a
              // still-down alternate gateway keeps its notice.
              void dismissGatewayDown(gateway.id);
            }
            if (decision.clearProbeMessage) setProbeMessage('');
            if (decision.clearLastError) setLastError(null);
            if (decision.notifyGatewayDown && !gatewayDownNotifiedRef.current) {
              gatewayDownNotifiedRef.current = true;
              void notifyGatewayDown(gateway.id, gatewayHostForDisplay(gateway.url));
            }
            if (decision.scheduleAutoRetry && activeGatewayRef.current && !authFailureRef.current) {
              scheduleAutoRetryRef.current(AUTO_RETRY_BASE_DELAY_MS);
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
              setMessages((prev) => markInterrupted(prev, activeRunId, 'Connection lost'));
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
      // Capability verdicts ride the client install: manifest clients answer
      // from their declared endpoints, every other adapter from method
      // presence — both known before any call is made.
      setHasBotManagement(probeBotManagement(client));
      setHasGroupRooms(probeGroupRooms(client));
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
      // would 404 "No provider declares model undefined"). Prefer a model
      // whose provider is signed in — the first row can be a locked one.
      if (!gateway.model && isCurrent()) {
        try {
          const models = await client.getModels();
          const first = models.find((model) => model.available !== false)?.id ?? models[0]?.id;
          if (first && isCurrent()) {
            const withModel = { ...gateway, model: first };
            setActiveGateway(withModel);
            void upsertGateway(withModel).then(setGateways);
          }
        } catch {
          // optional
        }
      }

      // A pin written while its provider was signed in outlives the login:
      // the picker's lock only applies while the picker is open, so nothing
      // else stops a send to the now-dead model. Re-validate the stored pin
      // against the live catalog off the connect path — a slow or failed
      // catalog read must not hold up or fail the connect.
      void (async () => {
        let catalog: Awaited<ReturnType<typeof client.getModels>>;
        try {
          catalog = await client.getModels();
        } catch {
          // An unreadable catalog says nothing about the pin — keep it.
          return;
        }
        if (!isCurrent()) return;
        const backendId = selectedBackendIdRef.current;
        const botId = selectedBotIdRef.current;
        // Validate the live profile, not the connect-time one — the operator
        // may have re-picked while the catalog read was in flight.
        const current = activeGatewayRef.current ?? gateway;
        const stale = staleModelPin(catalog, effectiveModel(current, backendId, botId));
        if (!stale) return;
        if (!stale.fallback) {
          setMessages((prev) =>
            appendSystemNote(
              prev,
              `Pinned model ${stale.pinned} cannot run — its provider is not signed in on the host, and the catalog has no signed-in model to switch to. Sign in (run hermes model on the host) or pick another model.`,
            ),
          );
          return;
        }
        const updated = withSelectedModel(current, stale.fallback, backendId, botId);
        // Same release as selectModel: the open session is pinned to the dead
        // model and a Hermes session cannot change its own, so the next send
        // must open a fresh one on the fallback.
        sessionIdRef.current = undefined;
        setCurrentSessionId(undefined);
        const pinnedProfile = pinLiveSession({
          client: clientRef.current ?? { setSessionId: () => undefined },
          sessionId: undefined,
          profile: updated,
        });
        const next = pinnedProfile ?? updated;
        activeGatewayRef.current = next;
        setActiveGateway(next);
        void upsertGateway(next).then(setGateways);
        setMessages((prev) =>
          appendSystemNote(
            prev,
            `Pinned model ${stale.pinned} cannot run — its provider is not signed in on the host. Switched to ${stale.fallback}; a new session opens on the next send.`,
          ),
        );
      })();

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
      skipManifest?: boolean,
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
      // and broke Gate (manifest on :8760). Identify before saving. The
      // discovery beacon kind travels with the call, so a gateway that
      // advertised its kind answers from the beacon fast path with no network
      // instead of replaying the full manifest + fingerprint cascade.
      if (!kind) {
        // A probe-wave winner known to be manifest-less skips the manifest
        // fetch the wave already ran; every other winner re-runs it — the
        // wave never checked the serial tail or a single-url probe.
        const identity = await identifyGateway({ baseUrl: url, beaconKind: beaconKindForUrl(discovered, url), skipManifest });
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
        setAutoRetry(null);
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
        // Discovery's fixed window runs while the synchronously-known
        // high-priority URLs are probed, instead of before them: the first
        // byte is probed immediately and the beacons merge when the window
        // lands. `discovered` still flows to every downstream use below.
        const discoveryPromise = discoverForProbe();
        const earlyUrls = buildEarlyProbeUrls({
          platform: Platform.OS,
          lastSuccessfulUrl: appSettings.lastSuccessfulUrl,
        });
        const earlyResult =
          earlyUrls.length > 0
            ? await probeHighPriorityCandidates(
                earlyUrls,
                setProbeMessage,
                GATEWAY_PROBE_PARALLEL_TIMEOUT_MS,
              )
            : null;
        const discovered = await discoveryPromise;

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
            const savedProbe =
              earlyResult?.ok && sameGatewayUrl(earlyResult.url, saved.url)
                ? earlyResult
                : await probeGatewayUrl(saved.url, GATEWAY_PROBE_TIMEOUT_MS);
            if (savedProbe.ok) {
              if (autoRetryTimerRef.current) {
                clearTimeout(autoRetryTimerRef.current);
                autoRetryTimerRef.current = null;
                setAutoRetry(null);
              }
              await saveAppSettings({ lastSuccessfulUrl: saved.url });
              setSettings((prev) => ({ ...prev, lastSuccessfulUrl: saved.url }));
              await connectGateway(saved);
              return;
            }
          }
        }

        const highPriorityUrls = mergeDiscoveredProbeUrls(earlyUrls, discovered);

        let probeResult: Awaited<ReturnType<typeof probeHighPriorityCandidates>> =
          earlyResult;

        if (!probeResult?.ok && highPriorityUrls.length > 0) {
          probeResult = await probeHighPriorityCandidates(
            highPriorityUrls,
            setProbeMessage,
            GATEWAY_PROBE_PARALLEL_TIMEOUT_MS,
          );
        }

        if (!probeResult?.ok) {
          const candidates = dropAlreadyWavedCandidates(
            buildGatewayCandidates({
              tailscaleHost: appSettings.tailscaleHost,
              configuredHosts: configuredGatewayHosts(),
              savedUrls: currentGateways.map((item) => item.url),
              discovered,
              lastSuccessfulUrl: appSettings.lastSuccessfulUrl,
              platform: Platform.OS,
            }),
            earlyUrls,
            highPriorityUrls,
          );

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
          undefined,
          probeResult.hasManifest === false,
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
    const [loaded, activeId] = await Promise.all([loadGateways(), loadActiveGatewayId()]);
    setGateways(loaded);
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

      // Adding a gateway IS completing onboarding: without this, a first-run
      // manual or deep-link add saved a profile yet left needsOnboarding set,
      // and AppBootstrap bounced the user from chat back to onboarding. The
      // derived tailnet host feeds future auto-connect candidate probing.
      const completionPatch = onboardingCompletionForAddedGateway(input.url, settingsRef.current);
      const nextSettings = await saveAppSettings(completionPatch);
      settingsRef.current = nextSettings;
      setSettings(nextSettings);
      setNeedsOnboarding(false);

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
      client?.setSessionId(undefined);
      selectedBackendIdRef.current = backendId;
      selectedBotIdRef.current = undefined;
      setSelectedBackendId(backendId);
      setSelectedBotId(undefined);
      sessionIdRef.current = undefined;
      setCurrentSessionId(undefined);
      setMessages([]);
      if (activeGateway) {
        // Restore the model last used in this backend, so a send after the
        // switch does not carry the previous backend's model id — and remember
        // the backend itself, so the next launch opens here rather than making
        // the operator pick it again. Drop the previous session pin: stored
        // is a reconnect pin, and leaving it would restore the old
        // environment's thread on the next connect.
        const restored = effectiveModel(activeGateway, backendId);
        const updated = {
          ...activeGateway,
          backendId,
          sessionId: undefined,
          ...(restored && restored !== activeGateway.model ? { model: restored } : {}),
        };
        setActiveGateway(updated);
        void upsertGateway(updated).then(setGateways);
        void reloadHistoryFor(updated);
      }
    },
    [activeGateway, reloadHistoryFor],
  );

  /**
   * Land a fresh connection on a usable backend without making the operator
   * go and find one.
   *
   * Every launch used to begin the same way: open Gate setup, tap the Hermes
   * chip, press Start on the CLI card, then go back to chat. None of it was a
   * decision — `selectedBackendId` simply began as undefined, and the setup
   * screen's `?? backends[0]` made claude-local LOOK selected while the
   * provider had nothing. This adopts the remembered backend (or the most
   * capable one) as soon as the manifest lands.
   *
   * Deliberately lighter than selectBackend: there is no thread to tear down
   * on first adoption, and clearing messages here would fight the history
   * reload the connect path is already running.
   *
   * The environment probe is not part of adoption. It fires whenever a
   * backend becomes the active one — first adoption (once selectedBackendId
   * lands), reconnect after the manifest re-lands, or an explicit switch —
   * so the setup card reads "ready" rather than staying "stopped" after
   * the first connect. Chat never needed it, so the probe is deferred and
   * its failure is named without blocking the connection.
   */
  useEffect(() => {
    if (!selectedBackendId && backends.length > 0) {
      const resolved = resolveDefaultBackend(backends, activeGatewayRef.current?.backendId);
      if (!resolved) return undefined;

      // Deferred a tick like every other loader here: writing state straight
      // from an effect body trips react-hooks/set-state-in-effect.
      const timer = setTimeout(() => {
        const client = clientRef.current as (PortalClient & { setBackendId?: (id?: string) => void }) | null;
        client?.setBackendId?.(resolved);
        setSelectedBackendId(resolved);

        const gateway = activeGatewayRef.current;
        if (gateway && gateway.backendId !== resolved) {
          const updated = { ...gateway, backendId: resolved };
          setActiveGateway(updated);
          void upsertGateway(updated).then(setGateways);
        }

        // The connect path already loaded history, but it did so before this
        // backend existed — an unscoped /v1/sessions resolves to whichever
        // environment the Gate picks by capability (claude-local here), so the
        // thread would show one backend's sessions while sends went to another.
        // Drop any session that earlier load pinned — it was resolved without
        // this scope and carries the wrong environment's immutable model pin —
        // then reload so the thread re-resolves under the adopted backend.
        sessionIdRef.current = undefined;
        if (gateway) void reloadHistoryFor(gateway);
      }, 0);
      return () => clearTimeout(timer);
    }

    const decision = decideEnvironmentProbe({
      backendId: selectedBackendId,
      lastProbedId: lastProbedBackendRef.current,
      backendsAvailable: backends.length > 0,
      connected: status === 'connected',
    });
    if (!decision.probeId) {
      lastProbedBackendRef.current = decision.lastProbedId;
      return undefined;
    }

    const probeId = decision.probeId;
    const timer = setTimeout(() => {
      lastProbedBackendRef.current = decision.lastProbedId;
      void probeEnvironmentLifecycle(gatewayRequest, probeId).then((result) => {
        if (!result.ok) setLastError(environmentProbeFailureText(probeId, result.error));
      });
    }, 0);
    return () => clearTimeout(timer);
  }, [backends, gatewayRequest, reloadHistoryFor, selectedBackendId, status]);


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
        setAutoRetry(null);
      }
      clientRef.current?.disconnect();
      clientRef.current = null;
      setHasBotManagement(false);
      setHasGroupRooms(false);
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
      setAutoRetry(null);
    }
    clientRef.current?.disconnect();
    clientRef.current = null;
    historyLoadedForRef.current = null;
    setActiveGateway(null);
    setActiveHello(null);
    setActiveManifest(null);
    applyStatus('disconnected');
    setHasBotManagement(false);
    setHasGroupRooms(false);
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

      // Coalesce per-chunk `setMessages` to at most one per frame.
      // Before: each SSE `data:` line triggered its own state write and FlatList pass.
      // After: deltas are buffered and flushed once per RAF (≈60fps), so 100
      // rapid chunks coalesce to ~1-2 renders with identical final text.
      const batcher = createStreamBatcher({ runId, setMessages });

      try {
        // Build bounded conversation context: last 20 real turns, no command payloads.
        const conversationMessages = [
          // Latest-committed via the ref mirror at the state declaration,
          // so this callback's identity stays stable across streamed frames.
          ...messagesRef.current
            .filter((m) => (m.role === 'user' || m.role === 'assistant') && !m.command && !m.queued && m.text.trim())
            .slice(-20)
            .map((m) => ({ role: m.role, content: m.text })),
          { role: 'user', content: trimmed },
        ];

        await client.streamChat(
          conversationMessages,
          (delta) => {
            batcher.queueDelta(delta);
          },
          {
            sessionId: sessionIdRef.current,
            ...resolveSendModel(gateway, selectedBackendId, selectedBotId),
            providerId: selectedBotId ? undefined : gateway.providerId,
            signal: abortController.signal,
            onToolCall: (toolCall) => {
              batcher.queueTool(toolCall);
            },
            onReasoning: (reasoning: string) => {
              batcher.queueReasoning(reasoning);
            },
            // A gateway may answer with a model the operator did not choose —
            // Hermes falls through `fallback_providers` and says so only in
            // its runtime block. Saying nothing left the thread looking like
            // the pick had been honoured, so a swap is now on the record.
            onModelReport: (report) => {
              if (!shouldShowModelSubstitution(report, lastSubstitutionRef.current)) return;
              const note = modelSubstitutionNote(report);
              if (note) {
                lastSubstitutionRef.current = report;
                setMessages((prev) => appendSystemNote(prev, note));
              }
            },
          },
        );

        batcher.flush();
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
          batcher.cancel();
          setMessages((prev) => convertStreamError(prev, runId, message, true));
        } else if (isConnectionError(error)) {
          batcher.flush();
          setMessages((prev) => markInterrupted(prev, runId, message));
          setLastError(message);
        } else {
          // Desktop-parity failure state: when the Gate names the host state
          // (multiplex off, refused key, dead environment, spent budget), the
          // bubble shows verdict + fix instead of a raw exception dump. The
          // banner still gets the raw message for anyone who wants details.
          batcher.cancel();
          const shown = formatRunFailure(message) ?? message;
          setMessages((prev) => convertStreamError(prev, runId, shown, false));
          setLastError(message);
        }
      } finally {
        setIsSending(false);
        activeRunIdRef.current = null;
        abortControllerRef.current = null;
      }
    },
    [activeGateway, isSending, selectedBackendId, selectedBotId],
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
      } catch (error) {
        // A refused start (client.startRun threw before onStarted re-keyed
        // the provisional entry) must not strand a forever-Running ghost in
        // the In-flight filter: settle the tracked id through the same
        // patchRun a finished run uses, then rethrow so the sendChatInput
        // catch still names the refusal in chat. This also covers a throw
        // later in the drive (trackedId is the real id by then), which
        // stranded the same ghost for the same reason.
        const message = error instanceof Error ? error.message : String(error);
        patchRun(trackedId.current, {
          status: 'failed',
          summary: message.slice(0, 160) || undefined,
          finishedAt: Date.now(),
        });
        throw error;
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

  /**
   * Drain a run's full event stream from the connected gateway. Subscribes via
   * `client.streamRunEvents`, collects every event the stream emits, and
   * resolves with the list when the stream closes end-to-end (the Gate sends
   * the SSE end-marker after the replay finishes). The `signal` lets the
   * caller cut a replay mid-stream when the sheet closes — the SSE response is
   * released and no more events are appended.
   */
  const loadRunEvents = useCallback(
    async (runId: string, signal: AbortSignal): Promise<RunEvent[]> => {
      const client = clientRef.current;
      if (!client || !client.streamRunEvents) {
        throw new Error('This gateway does not expose run events.');
      }
      const collected: RunEvent[] = [];
      await client.streamRunEvents(
        runId,
        (event) => {
          if (signal.aborted) return;
          collected.push(event);
        },
        signal,
      );
      return collected;
    },
    [],
  );

  const sendChatInput = useCallback(
    async (
      text: string,
      options?: { fromQueue?: boolean; messageId?: string; skills?: Skill[] },
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

      if (!isSlashCommandInput(trimmed) || shouldPassthroughSkillSlash(trimmed, options?.skills ?? [])) {
        await sendMessage(trimmed, options?.messageId);
        return;
      }

      const busySlash = decideBusySlash(trimmed, isCommandRunning, runningCommandLabel);
      if (busySlash.kind === 'busy') {
        // The guard still returns here: the note is feedback, never a second
        // concurrent command.
        appendLocalMessage('assistant', busySlash.note);
        return;
      }

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
          messages: messagesRef.current,
          resetConversation: () => createNewSessionRef.current(),
          restoreSession: (sessionId) => selectSessionRef.current(sessionId),
          createNewSession: (title) => createNewSessionRef.current(title),
          // The live Session id, so `/session current` answers from the
          // Session the app actually has open instead of asking the Gateway
          // for a `sessions.current` method no Gateway dispatches. The ref
          // is live; the state mirror may be stale inside this closure.
          currentSessionId: sessionIdRef.current,
          // Already fetched by the chat screen and handed to sendChatInput; /help
          // renders it. Passing it beats re-fetching, which put a network
          // round-trip in front of every mistyped command.
          skills: options?.skills ?? [],
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
                  const applied = applyModelOverride({
                    gateway,
                    modelId,
                    selectedBackendId: selectedBackendIdRef.current,
                    selectedBotId: selectedBotIdRef.current,
                    hasSession: Boolean(sessionIdRef.current),
                  });
                  // Release the live session so the next send opens one pinned
                  // to this model. Do not wipe the thread here — the slash
                  // confirmation still has to land on commandMessageId.
                  // Pinning the client is not enough: connect copies stored
                  // onto live before disconnect can rewrite it. Same persist
                  // as createNewSession.
                  let next = applied.gateway;
                  if (applied.releaseSession) {
                    sessionIdRef.current = undefined;
                    setCurrentSessionId(undefined);
                    const client = clientRef.current ?? { setSessionId: () => undefined };
                    const pinned = pinLiveSession({
                      client,
                      sessionId: undefined,
                      profile: applied.gateway,
                    });
                    if (pinned) next = pinned;
                  }
                  setActiveGateway(next);
                  if (next !== gateway) {
                    activeGatewayRef.current = next;
                  }
                  await upsertGateway(next).then(setGateways);
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
      runningCommandLabel,
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

  /**
   * Same shape as openSessionSelector: show first, read after. Awaiting
   * `getModels()` before setting `visible` meant a tap on the model chip did
   * nothing until the catalog answered, and a read landing after the operator
   * dismissed the sheet re-opened it.
   *
   * A cached catalog stays on screen while the re-read runs, so the common
   * case (already opened once this session) is populated immediately.
   */
  const openModelPicker = useCallback(async (mode: 'default' | 'fallbacks' | 'agent', agentId?: string) => {
    const seq = modelReadSeqRef.current + 1;
    modelReadSeqRef.current = seq;
    setModelPicker({ visible: true, mode, agentId });
    const client = clientRef.current;
    if (!client) return;
    try {
      const models = await client.getModels();
      if (seq !== modelReadSeqRef.current) return;
      setModelCatalog(models);
    } catch {
      // Keep picker usable with any cached catalog.
    }
  }, []);

  const closeModelPicker = useCallback(() => {
    setModelPicker({ visible: false, mode: 'default' });
  }, []);

  /**
   * Show the sheet FIRST, then read.
   *
   * This used to await the session read and only then set `visible`, so a tap
   * produced nothing at all until the network answered — up to the transport's
   * 30s ceiling. Reported from device use: 10-11s of blank, then a sheet that
   * opened already saying "Sessions could not be read". Worse, the tail set
   * `visible: true` unconditionally, so a read landing after the operator
   * dismissed the sheet re-opened it several seconds later.
   *
   * Opening first fixes both: the sheet is on screen in one frame, and nothing
   * after the await can re-show it. `sessionReadSeqRef` drops a superseded read
   * so a slow first open cannot overwrite a faster second one.
   */
  const openSessionSelector = useCallback(async () => {
    const seq = sessionReadSeqRef.current + 1;
    sessionReadSeqRef.current = seq;
    setSessionListState(beginSessionListRead);
    setSessionSelector({ visible: true });
    const client = clientRef.current;
    if (!client) return;
    // A fresh open starts back at one page — a widened window from a
    // previous "show older" must not stick around and surprise the next
    // open with a slower read.
    sessionListLimitRef.current = SESSION_LIST_PAGE_SIZE;
    try {
      const sessions = await client.getSessions(SESSION_LIST_PAGE_SIZE);
      if (seq !== sessionReadSeqRef.current) return;
      setSessionListState((previous) => applySessionListRead(previous, { ok: true, sessions }));
      setSessionListHasOlder(sessionListMayHaveOlder(sessions.length, SESSION_LIST_PAGE_SIZE));
    } catch {
      if (seq !== sessionReadSeqRef.current) return;
      setSessionListState((previous) => applySessionListRead(previous, { ok: false }));
    }
  }, []);

  const loadOlderSessions = useCallback(async () => {
    const client = clientRef.current;
    if (!client || loadingOlderSessions) return;
    const nextLimit = nextSessionListLimit(sessionListLimitRef.current);
    if (nextLimit <= sessionListLimitRef.current) {
      setSessionListHasOlder(false);
      return;
    }
    setLoadingOlderSessions(true);
    try {
      const sessions = await client.getSessions(nextLimit);
      sessionListLimitRef.current = nextLimit;
      setSessionListState((previous) => applySessionListRead(previous, { ok: true, sessions }));
      setSessionListHasOlder(sessionListMayHaveOlder(sessions.length, nextLimit));
    } catch {
      setSessionListState((previous) => applySessionListRead(previous, { ok: false }));
    } finally {
      setLoadingOlderSessions(false);
    }
  }, [loadingOlderSessions]);

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

      // The discovery window runs while the just-typed host is probed,
      // instead of before it: the first byte goes out immediately and the
      // beacons merge when the window lands. `discovered` still flows to
      // every downstream use below.
      const discoveryPromise = discoverForProbe(2500);
      const explicitCandidates = buildExplicitHostCandidates(host);

      applyConnectionPhase('searching');

      let probeResult = await probeHighPriorityCandidates(
        explicitCandidates,
        setProbeMessage,
        GATEWAY_PROBE_PARALLEL_TIMEOUT_MS,
      );

      const discovered = await discoveryPromise;

      // Wave one tried the explicit host; the second wave tries this delta's
      // head, so the serial tail below starts past that head.
      let unwavedCandidates = explicitCandidates;
      if (!probeResult?.ok) {
        const candidates = buildGatewayCandidates({
          tailscaleHost: host,
          configuredHosts: configuredGatewayHosts(),
          savedUrls: gateways.map((item) => item.url),
          discovered,
          lastSuccessfulUrl: nextSettings.lastSuccessfulUrl,
          platform: Platform.OS,
        });

        // The full list opens with the explicit host the first wave just
        // missed, so wave only the unwaved delta instead of re-probing it.
        unwavedCandidates = dropAlreadyWavedCandidates(candidates, explicitCandidates, []);
        probeResult = await probeHighPriorityCandidates(
          unwavedCandidates,
          setProbeMessage,
          GATEWAY_PROBE_PARALLEL_TIMEOUT_MS,
        );
      }

      if (!probeResult?.ok) {
        probeResult = await probeGatewayCandidates(
          unwavedCandidates.slice(HIGH_PRIORITY_WAVE_SIZE),
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
        probeResult.hasManifest === false,
      );
      const saved = await saveAppSettings({ lastSuccessfulUrl: probeResult.url });
      setSettings(saved);
      if (autoRetryTimerRef.current) {
        clearTimeout(autoRetryTimerRef.current);
        autoRetryTimerRef.current = null;
        setAutoRetry(null);
      }
      await connectGateway(gateway);
      return true;
    },
    [connectGateway, gateways, resolveGatewayForUrl, applyConnectionPhase],
  );

  // The connect cycle the auto-retry timer and the foreground heal both ride.
  // Deliberately does NOT forgive the failure streak — only a connected phase
  // or a human-initiated retry does that, or the ladder could never climb.
  const runAutoConnectCycle = useCallback(async () => {
    if (autoRetryTimerRef.current) {
      clearTimeout(autoRetryTimerRef.current);
      autoRetryTimerRef.current = null;
      setAutoRetry(null);
    }
    const [freshSettings, freshGateways, activeId] = await Promise.all([
      loadAppSettings(),
      loadGateways(),
      loadActiveGatewayId(),
    ]);
    const idToUse = activeId ?? (activeGateway?.id ?? null);
    await runAutoConnect(freshSettings, freshGateways, idToUse);
  }, [activeGateway?.id, runAutoConnect]);

  const retryAutoConnect = useCallback(async () => {
    // Human-initiated: whatever streak of failures piled up is forgiven and
    // pacing starts over at the base interval.
    autoRetryFailureStreakRef.current = 0;
    await runAutoConnectCycle();
  }, [runAutoConnectCycle]);

  const scheduleAutoRetry = useCallback((floorMs = AUTO_RETRY_BASE_DELAY_MS) => {
    if (!settingsRef.current.autoConnect) return;
    // Escalate per consecutive failure — 12s doubling up to a 5-minute cap —
    // instead of re-probing a down gateway on the same flat interval forever.
    const delayMs = autoRetryDelayMs(autoRetryFailureStreakRef.current, floorMs);
    // Mirror the pending schedule into state so the UI can show what is
    // waiting — including when the ladder has stopped accelerating.
    setAutoRetry(autoRetryPulse(autoRetryFailureStreakRef.current, floorMs));
    autoRetryFailureStreakRef.current += 1;
    if (autoRetryTimerRef.current) clearTimeout(autoRetryTimerRef.current);
    autoRetryTimerRef.current = setTimeout(() => {
      autoRetryTimerRef.current = null;
      setAutoRetry(null);
      const currentPhase = connectionPhaseRef.current;
      if (currentPhase === 'failed' || currentPhase === 'idle') {
        void runAutoConnectCycle();
      }
    }, delayMs);
  }, [runAutoConnectCycle]);

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
      void runAutoConnectCycle();
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
    void runAutoConnectCycle();
  }, [connectGateway, runAutoConnectCycle]);

  // Foreground/background lifecycle: pause reconnection while backgrounded
  // (timers are throttled anyway), heal fast on return to foreground.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') {
        clientRef.current?.suspendReconnect();
        if (autoRetryTimerRef.current) {
          clearTimeout(autoRetryTimerRef.current);
          autoRetryTimerRef.current = null;
          setAutoRetry(null);
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
    if (enabled) {
      // Re-enabling is a human decision — pacing restarts from the base
      // interval instead of inheriting a stale failure streak.
      autoRetryFailureStreakRef.current = 0;
    } else if (autoRetryTimerRef.current) {
      // Turning auto-connect OFF cancels anything already queued: a visible
      // cool-down must never promise a retry that will not happen.
      clearTimeout(autoRetryTimerRef.current);
      autoRetryTimerRef.current = null;
      setAutoRetry(null);
    }
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

      // A Hermes session's model is fixed at creation, so a pick made
      // mid-thread would never reach the wire — every later turn keeps
      // answering on whatever the session was opened with. Release the session
      // so the next send opens a fresh one pinned to the choice; same trade
      // selectBackend already makes, and the only way the picker means
      // anything after turn one.
      // Pinning the client is not enough: connect copies stored onto live
      // before disconnect can rewrite it. Same persist as createNewSession.
      const previousModel = effectiveModel(activeGateway, selectedBackendId, selectedBotId);
      const released = shouldReleaseSessionForModel({
        previous: previousModel,
        next: modelId,
        hasSession: Boolean(sessionIdRef.current),
      });
      let next = updated;
      if (released) {
        sessionIdRef.current = undefined;
        setCurrentSessionId(undefined);
        setMessages(
          appendSystemNote([], modelSwitchAnnouncement({ previous: previousModel ?? modelId, next: modelId })),
        );
        const client = clientRef.current ?? { setSessionId: () => undefined };
        const pinned = pinLiveSession({
          client,
          sessionId: undefined,
          profile: updated,
        });
        if (pinned) next = pinned;
      }
      setActiveGateway(next);
      if (next !== activeGateway) {
        activeGatewayRef.current = next;
      }
      void upsertGateway(next).then(setGateways);
    },
    [activeGateway, closeModelPicker, sendChatInput, selectedBackendId, selectedBotId],
  );

  const selectSession = useCallback(async (sessionId: string) => {
    closeSessionSelector();
    const client = clientRef.current;
    // The slash path reads `session.restore` and switches only after it
    // resolves; the tap used to pin first and fail at the history read
    // after. Validate through the same read ahead of the pin: a rejection
    // names the failure and keeps the current thread. Where the method is
    // not dispatched on this path (no client) the switch stays instant.
    const validation = await validateThreadSwitch(
      client?.rpcRequest.bind(client),
      sessionId,
    );
    if (!validation.ok) {
      setLastError(threadSwitchFailureText(sessionId, validation.error));
      return;
    }
    // Pinning the client is not enough: connect copies stored onto live
    // before disconnect can rewrite it. Same persist as createNewSession.
    const pinned = client
      ? pinLiveSession({
          client,
          sessionId,
          profile: activeGateway ?? undefined,
        })
      : undefined;
    sessionIdRef.current = sessionId;
    setCurrentSessionId(sessionId);
    if (pinned && pinned !== activeGateway) {
      activeGatewayRef.current = pinned;
      setActiveGateway(pinned);
      void upsertGateway(pinned).then(setGateways);
    }
    const gateway = pinned ?? activeGateway;
    if (gateway) {
      void reloadHistoryFor(gateway);
    }
  }, [closeSessionSelector, activeGateway, reloadHistoryFor]);

  useEffect(() => {
    selectSessionRef.current = selectSession;
  }, [selectSession]);

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
    // Destructive counterpart to run/pause. The Gate dispatches the
    // `jobs.remove` RPC (gate/core/capabilities/gateway-methods.mjs) to the
    // resolved backend's `removeJob`; a backend without that method throws
    // and the caller surfaces the refusal through the same control-error
    // path the run/pause calls already use.
    remove: async (jobId: string) => {
      const client = clientRef.current;
      if (!client?.removeJob) throw new Error('This gateway does not remove jobs.');
      await client.removeJob(jobId);
    },
  }), []);

  const cron = useMemo(() => ({
    get available() {
      return typeof clientRef.current?.listCronJobs === 'function';
    },
    list: async () => {
      const client = clientRef.current;
      if (!client?.listCronJobs) return [];
      return client.listCronJobs();
    },
    runs: async (jobId: string) => {
      const client = clientRef.current;
      if (!client?.cronRuns) return [];
      return client.cronRuns(jobId);
    },
    transcript: async (runId: string, limit?: number) => {
      const client = clientRef.current;
      if (!client?.cronTranscript) return [];
      return client.cronTranscript(runId, limit);
    },
  }), []);

  const botGroups = useMemo(() => ({
    list: async () => {
      const client = clientRef.current;
      if (!client?.listGroups) return [];
      return client.listGroups();
    },
    create: async (input: { name: string; memberIds: string[] }) => {
      const client = clientRef.current;
      if (!client?.createGroup) throw new Error('This gateway does not manage group rooms.');
      return client.createGroup(input);
    },
    send: async (groupId: string, input: { text: string; mentionedIds?: string[] }) => {
      const client = clientRef.current;
      if (!client?.sendGroupMessage) throw new Error('This gateway does not manage group rooms.');
      return client.sendGroupMessage(groupId, input);
    },
    history: async (groupId: string) => {
      const client = clientRef.current;
      // A gate without rooms (or an older client surface) simply has no
      // replayable transcript — degrade to empty like list does.
      if (!client?.groupHistory) return [];
      return client.groupHistory(groupId);
    },
    rename: async (groupId: string, name: string) => {
      const client = clientRef.current;
      if (!client?.renameGroup) throw new Error('This gateway does not manage group rooms.');
      return client.renameGroup(groupId, name);
    },
    leave: async (groupId: string, memberId: string) => {
      const client = clientRef.current;
      if (!client?.leaveGroup) throw new Error('This gateway does not manage group rooms.');
      return client.leaveGroup(groupId, memberId);
    },
    deleteGroup: async (groupId: string) => {
      const client = clientRef.current;
      if (!client?.deleteGroup) throw new Error('This gateway does not manage group rooms.');
      return client.deleteGroup(groupId);
    },
    addMembers: async (groupId: string, memberIds: string[]) => {
      const client = clientRef.current;
      if (!client?.addGroupMembers) throw new Error('This gateway does not manage group rooms.');
      return client.addGroupMembers(groupId, memberIds);
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

  const updateBot = useCallback(async (input: {
    id: string;
    soul?: string;
    description?: string;
    modelId?: string | null;
    providerId?: string | null;
  }): Promise<PublicBot> => {
    const client = clientRef.current;
    if (!client?.updateBot) {
      throw new Error('This gateway does not edit bots.');
    }
    return client.updateBot(input);
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
      // Pinning the client is not enough: connect copies stored onto live
      // before disconnect can rewrite it. Same persist as selectSession.
      const pinned = pinLiveSession({
        client,
        sessionId: chat.id,
        profile: activeGateway ?? undefined,
      });
      sessionIdRef.current = chat.id;
      setCurrentSessionId(chat.id);
      setSessionListState((previous) =>
        previous.sessions.some((session) => session.id === chat.id)
          ? previous
          : { ...previous, sessions: [chat, ...previous.sessions] },
      );
      if (pinned && pinned !== activeGateway) {
        activeGatewayRef.current = pinned;
        setActiveGateway(pinned);
        void upsertGateway(pinned).then(setGateways);
      }
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
      // Pin the operator's model as the session is opened. A Hermes session's
      // model cannot be changed afterwards, so a session created bare is
      // permanently stuck on the host default no matter what the picker shows.
      const created = await client.createSession(
        title,
        effectiveModel(activeGateway, selectedBackendId, selectedBotId),
      );
      // Gate createSession does not assign currentSessionId. Without this
      // pin, disconnect still writes the previous session onto the profile
      // and connect copies it back onto live — the new thread is orphaned.
      const pinned = pinLiveSession({
        client,
        sessionId: created.id,
        profile: activeGateway ?? undefined,
      });
      sessionIdRef.current = created.id;
      setCurrentSessionId(created.id);
      setMessages([]);
      setSessionListState((previous) => ({
        ...previous,
        sessions: [created, ...previous.sessions],
      }));
      if (pinned && pinned !== activeGateway) {
        activeGatewayRef.current = pinned;
        setActiveGateway(pinned);
        void upsertGateway(pinned).then(setGateways);
      }
    } catch (error) {
      setLastError(error instanceof Error ? error.message : String(error));
    }
    closeSessionSelector();
  }, [activeGateway, closeSessionSelector, selectedBackendId, selectedBotId]);
  useEffect(() => {
    createNewSessionRef.current = createNewSession;
  }, [createNewSession]);

  const deleteSessionById = useCallback(
    async (sessionId: string) => {
      const client = clientRef.current;
      if (!client?.deleteSession) return;
      try {
        await client.deleteSession(sessionId);
        setSessionListState((previous) => ({
          ...previous,
          sessions: previous.sessions.filter((session) => session.id !== sessionId),
        }));
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
      lastError,
      clearLastError,
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
      activeManifest,
      selectedBackendId,
      selectBackend,
      selectedBotId,
      listBots,
      createBot,
      updateBot,
      hasBotManagement,
      hasGroupRooms,
      openBot,
      clearBot,
      botJobs,
      botGroups,
      cron,
      runAgentCommand,
      dynamicCommands,
      setupFromPcAddress,
      retryAutoConnect,
      autoRetry,
      setAutoConnect,
      recentCommands,
      commandTranscripts,
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
      loadRunEvents,
      modelPicker,
      openModelPicker,
      closeModelPicker,
      selectModel,
      modelCatalog,
      sessionSelector,
      openSessionSelector,
      closeSessionSelector,
      selectSession,
      sessionList: sessionListState.sessions,
      sessionListError: sessionListCopy(sessionListState),
      sessionListLoaded: sessionListState.loaded,
      sessionListHasOlder,
      loadingOlderSessions,
      loadOlderSessions,
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
      lastError, clearLastError, deviceId, pairingDetails,
      settings, isBootstrapped, needsOnboarding, refreshGateways, addGateway, deleteGateway,
      connectGateway, disconnectGateway, sendChatInput, stopStreaming, reloadHistory,
      cron, gatewayRequest, gatewayFetch, backends, activeManifest, selectedBackendId, selectBackend, selectedBotId, listBots, createBot, updateBot, hasBotManagement, hasGroupRooms, openBot, clearBot, botJobs, botGroups, runAgentCommand, setupFromPcAddress, retryAutoConnect, autoRetry,
      setAutoConnect, recentCommands, commandTranscripts, retryCommand, cancelCommand, capabilitySnapshot,
      refreshCapabilities, pendingConfirmation, confirmPendingAction, cancelPendingConfirmation,
      pendingRunApproval, resolveRunApproval,
      approveTlsFingerprintChange,
      rejectTlsFingerprintChange,
      runTask, activityRuns, stopActivityRun, loadRunEvents, modelPicker, openModelPicker, closeModelPicker,
      selectModel, modelCatalog, sessionSelector,
      openSessionSelector, closeSessionSelector, selectSession, sessionListState, currentSessionId,
      sessionListHasOlder, loadingOlderSessions, loadOlderSessions,
      historyLoading, createNewSession, deleteSessionById, deleteLocalMessage,
      tlsFingerprintChange,
      dynamicCommands,
      hasMoreHistory, loadingEarlierHistory, loadEarlierMessages,
    ],
  );

  // The three streaming-scoped states live in a nested context, so a
  // coalesced streamed frame (iter-015) rebuilds only this value and
  // re-renders the chat surface alone — the other mounted tabs keep the
  // outer value's identity.
  const chatSurfaceValue = useMemo<ChatSurfaceContextValue>(
    () => ({ messages, isSending, isCommandRunning }),
    [messages, isSending, isCommandRunning],
  );

  return (
    <GatewayContext.Provider value={value}>
      <ChatSurfaceContext.Provider value={chatSurfaceValue}>
        {children}
      </ChatSurfaceContext.Provider>
    </GatewayContext.Provider>
  );
}

export function useChatSurface() {
  const context = useContext(ChatSurfaceContext);
  if (!context) throw new Error('useChatSurface must be used within GatewayProvider');
  return context;
}

export function useGateway() {
  const context = useContext(GatewayContext);
  if (!context) throw new Error('useGateway must be used within GatewayProvider');
  return context;
}
