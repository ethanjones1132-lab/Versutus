import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  GatewayValueProvider,
  type ChatSurfaceContextValue,
  type GatewayContextValue,
} from '@/context/gateway-provider';
import {
  SHOWCASE_APPROVALS,
  SHOWCASE_BOTS,
  SHOWCASE_GATEWAY,
  SHOWCASE_GROUP_HISTORY,
  SHOWCASE_GROUPS,
  SHOWCASE_MODELS,
  SHOWCASE_REPLIES,
  SHOWCASE_RUNS,
  SHOWCASE_SESSIONS,
  SHOWCASE_TRANSCRIPTS,
} from '@/lib/demo/showcase-fleet';
import type { ChatMessage, GatewayCapabilities, GatewayHelloOk } from '@/lib/gateway/types';
import { registerCrestFleet } from '@/lib/bot-avatar';
import { GATEWAY_COMMANDS, buildCapabilitySnapshot } from '@/lib/gateway/dashboard';

type Value = GatewayContextValue;

const HELLO: GatewayHelloOk = {
  type: 'hello-ok',
  protocol: 3,
  server: { version: 'showcase' },
  auth: { role: 'operator', scopes: ['operator.read', 'operator.write', 'operator.admin'] },
};

const CAPABILITIES: GatewayCapabilities = {
  object: 'capabilities',
  platform: 'versutus-gate',
  model: SHOWCASE_GATEWAY.model ?? '',
  auth: { type: 'bearer', required: true },
  runtime: { mode: 'gate', tool_execution: 'server', split_runtime: false, description: 'Showcase' },
  features: {
    chat: true,
    runs: true,
    sessions: true,
    approvals: true,
    models: true,
    skills: true,
    tools: true,
    cron: true,
    providers: true,
    environments: true,
  },
  endpoints: {},
};

/** Read once when the showcase loads: the fleet's capabilities never change. */
const CAPABILITY_SNAPSHOT = buildCapabilitySnapshot(
  'connected',
  HELLO,
  GATEWAY_COMMANDS,
  Date.now(),
  CAPABILITIES,
);

const idle = () => undefined;
const settle = async () => undefined;

/** Words a reply streams in, a few at a time, so the stream reads live. */
function chunks(text: string): string[] {
  return text.match(/\S+\s*/g) ?? [text];
}

/**
 * The gateway value for the showcase fleet (`showcase-mode.ts`). Reads answer
 * from `showcase-fleet.ts`; a send streams a canned reply so the streaming
 * signal, the composer's Stop and the transcript's rise-in can all be judged.
 * Nothing here opens a socket or touches storage.
 */
export function DemoGatewayProvider({ children }: { children: React.ReactNode }) {
  const [selectedBotId, setSelectedBotId] = useState<string | undefined>(undefined);
  const [transcripts, setTranscripts] = useState<Record<string, ChatMessage[]>>(SHOWCASE_TRANSCRIPTS);
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [requestedSurface, setRequestedSurface] = useState<Value['requestedSurface']>(null);
  const [modelPicker, setModelPicker] = useState<Value['modelPicker']>({ visible: false, mode: 'default' });
  const [sessionSelector, setSessionSelector] = useState({ visible: false });
  const [currentSessionId, setCurrentSessionId] = useState<string | undefined>('s-brief');
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  // The think beat, held apart from the interval: while it is pending there is
  // no interval to clear, so Stop and unmount need their own handle (DEMO-1).
  const beat = useRef<ReturnType<typeof setTimeout> | null>(null);
  const threadKey = selectedBotId ?? 'chat';

  useEffect(() => () => {
    if (beat.current) clearTimeout(beat.current);
    if (timer.current) clearInterval(timer.current);
  }, []);

  const finishStream = useCallback(() => {
    if (beat.current) clearTimeout(beat.current);
    beat.current = null;
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    setStreamingId(null);
    setTranscripts((all) => {
      const next: Record<string, ChatMessage[]> = {};
      for (const [key, list] of Object.entries(all)) {
        next[key] = list.map((message) => (message.streaming ? { ...message, streaming: false } : message));
      }
      return next;
    });
  }, []);

  const sendChatInput = useCallback<Value['sendChatInput']>(
    async (text) => {
      const trimmed = text.trim();
      if (!trimmed) return 'empty';
      // The beat is as much "busy" as the interval: a second send that enters
      // before the first interval exists would otherwise both append a reply
      // and overwrite the single timer ref, leaking the first interval (DEMO-2).
      if (timer.current || beat.current) return 'busy';
      const key = threadKey;
      const now = Date.now();
      const replyId = `showcase-reply-${now}`;
      const words = chunks(SHOWCASE_REPLIES[key] ?? SHOWCASE_REPLIES.chat);
      setTranscripts((all) => ({
        ...all,
        [key]: [
          ...(all[key] ?? []),
          { id: `showcase-user-${now}`, role: 'user', text: trimmed, timestamp: now },
          { id: replyId, role: 'assistant', text: '', timestamp: now + 1, streaming: true },
        ],
      }));
      setStreamingId(replyId);
      let shown = 0;
      // A short beat before the first word, like a model thinking. Held in a
      // ref so Stop during the beat cancels it instead of letting a reply
      // stream into a bubble the operator already settled (DEMO-1).
      beat.current = setTimeout(() => {
        beat.current = null;
        timer.current = setInterval(() => {
          shown += 2;
          const body = words.slice(0, shown).join('');
          setTranscripts((all) => ({
            ...all,
            [key]: (all[key] ?? []).map((message) =>
              message.id === replyId ? { ...message, text: body } : message,
            ),
          }));
          if (shown >= words.length) finishStream();
        }, 70);
      }, 650);
      return 'sent';
    },
    [finishStream, threadKey],
  );

  const value = useMemo<Value>(
    () => ({
      gateways: [SHOWCASE_GATEWAY],
      activeGateway: SHOWCASE_GATEWAY,
      activeHello: HELLO,
      status: 'connected',
      statusDetail: 'Connected to Atlas',
      connectionPhase: 'connected',
      probeMessage: '',
      lastError: null,
      clearLastError: idle,
      deviceId: 'showcase-device-7f3a9c',
      deviceIdState: 'ready',
      deviceIdError: null,
      reloadDeviceId: idle,
      pairingDetails: null,
      settings: { autoConnect: true, onboardingComplete: true, pcName: 'Atlas', voiceEngine: 'auto' },
      isBootstrapped: true,
      needsOnboarding: false,
      refreshGateways: settle,
      addGateway: async () => SHOWCASE_GATEWAY,
      gatewayRequest: async <T,>(method: string, params?: Record<string, unknown>) => {
        if (method === 'sessions.list') return { sessions: SHOWCASE_SESSIONS } as T;
        if (method === 'bots.get') {
          const bot = SHOWCASE_BOTS.find((candidate) => candidate.id === params?.id);
          return { ...bot, soul: bot?.description ?? '' } as T;
        }
        return {} as T;
      },
      gatewayFetch: async () => {
        throw new Error('The showcase fleet has no live Gate.');
      },
      backends: [],
      activeManifest: null,
      selectedBackendId: undefined,
      selectBackend: idle,
      selectedBotId,
      listBots: async () => {
        registerCrestFleet(SHOWCASE_BOTS.map((bot) => bot.id));
        return SHOWCASE_BOTS;
      },
      routineJobs: [],
      routineRead: { jobs: [], status: 'ready', gatewayId: SHOWCASE_GATEWAY.id },
      canReadBotSessions: false,
      readBotSessions: async () => ({ sessions: [] }),
      createBot: async (input) => ({ id: input.name.toLowerCase(), displayName: input.name, routable: true }),
      updateBot: async (input) => SHOWCASE_BOTS.find((bot) => bot.id === input.id) ?? SHOWCASE_BOTS[0],
      hasBotManagement: true,
      hasGroupRooms: true,
      openBot: async (botId) => {
        setSelectedBotId(botId);
        return true;
      },
      clearBot: () => setSelectedBotId(undefined),
      requestedSurface,
      requestSurface: setRequestedSurface,
      clearRequestedSurface: () => setRequestedSurface(null),
      requestedComposerFocus: null,
      requestComposerFocus: idle,
      clearRequestedComposerFocus: idle,
      requestedComposeRequest: null,
      requestComposeRequest: idle,
      clearRequestedComposeRequest: idle,
      requestedRunFocus: null,
      requestRunFocus: idle,
      clearRequestedRunFocus: idle,
      botJobs: {
        list: async () => [],
        create: async (input) => ({ id: `job-${input.name}`, name: input.name }),
        run: settle,
        pause: settle,
        remove: settle,
      },
      cron: {
        available: false,
        list: async () => [],
        runs: async () => [],
        transcript: async () => [],
      },
      botGroups: {
        list: async () => SHOWCASE_GROUPS,
        create: async (input) => ({ id: input.name.toLowerCase(), name: input.name, memberIds: input.memberIds }),
        send: async () => ({ replies: [{ botId: 'aria', text: 'Noted — I will fold that into the 9:00 note.' }] }),
        history: async () => SHOWCASE_GROUP_HISTORY,
        rename: async (groupId, name) => ({ ...SHOWCASE_GROUPS[0], id: groupId, name }),
        leave: async () => SHOWCASE_GROUPS[0],
        deleteGroup: async () => ({ ok: true }),
        addMembers: async () => SHOWCASE_GROUPS[0],
      },
      runAgentCommand: async () => '',
      relatedWorkflows: [],
      dynamicCommands: [],
      deleteGateway: settle,
      connectGateway: settle,
      disconnectGateway: idle,
      sendChatInput,
      stopStreaming: async () => finishStream(),
      reloadHistory: settle,
      setupFromPcAddress: async () => ({ kind: 'connected' }),
      retryAutoConnect: settle,
      autoRetry: null,
      setAutoConnect: settle,
      recentCommands: ['/status', '/models', '/run'],
      commandTranscripts: [],
      retryCommand: idle,
      cancelCommand: idle,
      capabilitySnapshot: CAPABILITY_SNAPSHOT,
      refreshCapabilities: idle,
      pendingConfirmation: null,
      confirmPendingAction: idle,
      cancelPendingConfirmation: idle,
      pendingRunApproval: null,
      resolveRunApproval: idle,
      pendingApprovals: SHOWCASE_APPROVALS,
      pendingApprovalsState: 'ready',
      pendingApprovalsError: null,
      refreshPendingApprovals: settle,
      decideApproval: settle,
      approvalBusy: null,
      tlsFingerprintChange: null,
      approveTlsFingerprintChange: settle,
      rejectTlsFingerprintChange: idle,
      runTask: async () => ({ runId: 'showcase-run', status: 'complete' }),
      activityRuns: SHOWCASE_RUNS,
      activityRunsForActiveGateway: SHOWCASE_RUNS,
      stopActivityRun: idle,
      loadRunEvents: async () => [],
      modelPicker,
      openModelPicker: (mode, agentId) => setModelPicker({ visible: true, mode, agentId }),
      closeModelPicker: () => setModelPicker((picker) => ({ ...picker, visible: false })),
      selectModel: () => setModelPicker((picker) => ({ ...picker, visible: false })),
      clearModelLock: idle,
      modelCatalog: SHOWCASE_MODELS,
      modelCatalogError: undefined,
      modelCatalogLoaded: true,
      sessionSelector,
      openSessionSelector: () => setSessionSelector({ visible: true }),
      closeSessionSelector: () => setSessionSelector({ visible: false }),
      selectSession: (sessionId) => {
        setCurrentSessionId(sessionId);
        setSessionSelector({ visible: false });
      },
      sessionList: SHOWCASE_SESSIONS,
      sessionListError: undefined,
      sessionListLoaded: true,
      sessionListHasOlder: false,
      loadingOlderSessions: false,
      loadOlderSessions: settle,
      currentSessionId,
      historyLoading: false,
      createNewSession: settle,
      deleteSessionById: settle,
      deleteLocalMessage: (id) =>
        setTranscripts((all) => ({
          ...all,
          [threadKey]: (all[threadKey] ?? []).filter((message) => message.id !== id),
        })),
      hasMoreHistory: false,
      loadingEarlierHistory: false,
      loadEarlierMessages: settle,
    }),
    [
      currentSessionId,
      finishStream,
      modelPicker,
      requestedSurface,
      selectedBotId,
      sendChatInput,
      sessionSelector,
      threadKey,
    ],
  );

  const chat = useMemo<ChatSurfaceContextValue>(
    () => ({
      messages: transcripts[threadKey] ?? [],
      isSending: streamingId !== null,
      isCommandRunning: false,
    }),
    [streamingId, threadKey, transcripts],
  );

  return (
    <GatewayValueProvider value={value} chat={chat}>
      {children}
    </GatewayValueProvider>
  );
}
