import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import { ApprovalSheet } from '@/components/chat/approval-sheet';
import { BotDetailSheet } from '@/components/chat/bot-detail-sheet';
import { ChatComposer } from '@/components/chat/chat-composer';
import { ChatRoster } from '@/components/chat/chat-roster';
import { CreateGroupSheet } from '@/components/chat/create-group-sheet';
import { GroupRoomActionSheet } from '@/components/chat/group-room-action-sheet';
import { GroupRoomView } from '@/components/chat/group-room-view';
import { NewAgentSheet } from '@/components/chat/new-agent-sheet';
import { RoutinesPane } from '@/components/chat/routines-pane';
import { SkillsPane } from '@/components/chat/skills-pane';
import { ThreadSpendGlance } from '@/components/chat/thread-spend-glance';
import { ToolsPane } from '@/components/chat/tools-pane';
import { DayDivider } from '@/components/chat/day-divider';
import { ChatEmptyState } from '@/components/chat/chat-empty-state';
import { ChatHeader } from '@/components/chat/chat-header';
import { ChatOverflowSheet, type ChatSessionStats } from '@/components/chat/chat-overflow-sheet';
import { ConfirmationSheet } from '@/components/chat/confirmation-sheet';
import { MessageActionsSheet } from '@/components/chat/message-actions-sheet';
import { MessageBubble } from '@/components/chat/message-bubble';
import { PairingSheet } from '@/components/chat/pairing-sheet';
import { ThreadConfigSheet, type SessionItem } from '@/components/chat/thread-config-sheet';
import { SlashCommandPalette } from '@/components/chat/slash-command-palette';
import { Button, EmptyState, ErrorCard, Icon, PressableScale, Screen, Skeleton, Text } from '@/components/ui';
import { Motion, Radius, Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import { describeGatewayError, humanizeGatewayError } from '@/lib/gateway/error-humanizer';
import { useTokens } from '@/hooks/use-tokens';
import { getSlashCommandSuggestions } from '@/lib/gateway/slash-commands';
import { formatDayDivider } from '@/lib/format';
import { resolvePullRefreshAction } from '@/lib/gateway/messages';
import type { ChatMessage, HermesSession } from '@/lib/gateway/types';
import { applyRosterRead } from '@/lib/gateway/roster-read';
import { botToEditInput, buildBotUpdatePatch, buildRoster, type ChatSurface, type PublicBot, type RosterRow } from '@/lib/gateway/bots';
import {
  applyGroupRead,
  describeRoomError,
  EMPTY_GROUPS,
  groupsListCopy,
  resolveOpenGroup,
  rosterInventoryVerified,
  type BotGroupRoom,
} from '@/lib/gateway/groups';
import {
  applyRoutineRead,
  EMPTY_ROUTINES,
  routineName,
  type RoutineRead,
  type RoutinesState,
} from '@/lib/gateway/routines';
import {
  applySessionSpendRead,
  EMPTY_SESSION_SPEND,
  sessionSpendReadFromUnknown,
  threadSpendCopy,
  type SessionSpendState,
} from '@/lib/gateway/session-analytics';
import {
  applySkillsRead,
  EMPTY_SKILLS,
  skillsReadFromUnknown,
  type SkillsState,
} from '@/lib/gateway/skills';
import {
  applyToolsetsRead,
  EMPTY_TOOLSETS,
  toolsetsListParams,
  toolsetsReadFromUnknown,
  toolsetsVisibleOn,
  type ToolsetsState,
} from '@/lib/gateway/toolsets';
import {
  applyComposerDraft,
  composerDraftKey,
  composerDraftThread,
  loadComposerDraft,
  readComposerDraft,
  saveComposerDraft,
} from '@/lib/gateway/composer-draft';
import { effectiveModel } from '@/lib/gateway/model-selection';
import { resolveThreadConfigMode, threadConfigOfferedModes, type ThreadConfigMode } from '@/lib/gateway/thread-config';
import { useAmbientParallaxScroll } from '@/lib/motion/ambient-parallax';

const PIN_THRESHOLD_PX = 96;
const JUMP_PILL_THRESHOLD_PX = 260;
// Any offset within this of the true top counts as "at top" so the pull
// gesture pages back instead of reloading the same window (bounce rounding
// and the header button keep tiny offsets live).
const AT_TOP_PX = 8;

type SessionRecord = HermesSession & { sessionId?: string; name?: string };

function toSessionItem(session: SessionRecord): SessionItem {
  return {
    id: session.id || session.sessionId || session.name || '',
    title: session.title ?? session.name ?? undefined,
    preview: session.preview ?? undefined,
    status: session.ended_at ? 'ended' : undefined,
    numMessages: session.message_count,
    totalTokens: (session.input_tokens ?? 0) + (session.output_tokens ?? 0),
    costUsd: session.actual_cost_usd ?? session.estimated_cost_usd,
    updatedAt: session.last_active ? session.last_active * (session.last_active > 1_000_000_000_000 ? 1 : 1000) : undefined,
  };
}

function ChatSkeleton() {
  return (
    <View style={styles.skeletonWrap}>
      <Skeleton width="62%" height={64} radius={Radius.lg} style={styles.skeletonLeft} />
      <Skeleton width="48%" height={44} radius={Radius.lg} style={styles.skeletonRight} />
      <Skeleton width="70%" height={88} radius={Radius.lg} style={styles.skeletonLeft} />
    </View>
  );
}

export function ChatScreen() {
  const router = useRouter();
  const tokens = useTokens();
  const {
    activeGateway,
    settings,
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
    sendChatInput,
    activeHello,
    reloadHistory,
    retryAutoConnect,
    retryCommand,
    cancelCommand,
    pendingConfirmation,
    confirmPendingAction,
    cancelPendingConfirmation,
    modelPicker,
    openModelPicker,
    closeModelPicker,
    stopStreaming,
    selectModel,
    modelCatalog,
    sessionSelector,
    openSessionSelector,
    closeSessionSelector,
    selectSession,
    sessionList,
    sessionListError,
    currentSessionId,
    pendingRunApproval,
    resolveRunApproval,
    recentCommands,
    historyLoading,
    hasMoreHistory,
    loadingEarlierHistory,
    loadEarlierMessages,
    createNewSession,
    deleteSessionById,
    deleteLocalMessage,
    disconnectGateway,
    capabilitySnapshot,
    dynamicCommands,
    backends,
    selectedBackendId,
    selectBackend,
    listBots,
    createBot,
    updateBot,
    hasBotManagement,
    hasGroupRooms,
    openBot,
    clearBot,
    botJobs,
    botGroups,
    selectedBotId,
    gatewayRequest,
  } = useGateway();

  // Keyed by gateway + surface + session so leaving a thread and coming
  // back restores that thread's unsent text, never another Bot's.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [dismissedPairingKey, setDismissedPairingKey] = useState<string | null>(null);
  const [overflowVisible, setOverflowVisible] = useState(false);
  const [backendPickerVisible, setBackendPickerVisible] = useState(false);
  const [paletteVisible, setPaletteVisible] = useState(false);
  const [actionMessage, setActionMessage] = useState<ChatMessage | null>(null);
  const [jumpVisible, setJumpVisible] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [surface, setSurface] = useState<ChatSurface>({ kind: 'roster' });
  const [rosterRows, setRosterRows] = useState<RosterRow[]>([{ kind: 'configurable' }]);
  // Starts true: nothing has loaded yet. The roster effect's resolve/reject
  // callbacks clear it — the flag is never written synchronously in an effect
  // body (react-hooks/set-state-in-effect), and the skeleton only renders for
  // a CONNECTED roster, so a gateway that never connects cannot pin it.
  const [rosterLoading, setRosterLoading] = useState(true);
  const [rosterError, setRosterError] = useState<string | undefined>();
  const [newAgentVisible, setNewAgentVisible] = useState(false);
  const [newAgentBusy, setNewAgentBusy] = useState(false);
  const [newAgentError, setNewAgentError] = useState<string | undefined>();
  // The Bot being edited, if any — keys the shared agent sheet so its state resets per target.
  const [editingBot, setEditingBot] = useState<PublicBot | null>(null);
  // Long-press target on the roster: which Bot's detail sheet is open.
  const [detailBot, setDetailBot] = useState<PublicBot | null>(null);
  // Long-press target on the roster: which room's action sheet is open.
  const [detailGroup, setDetailGroup] = useState<BotGroupRoom | null>(null);
  const [routineState, setRoutineState] = useState<RoutinesState & { botId?: string }>({
    ...EMPTY_ROUTINES,
  });
  const [skillsState, setSkillsState] = useState<SkillsState & { botId?: string }>({
    ...EMPTY_SKILLS,
  });
  const [toolsetsState, setToolsetsState] = useState<ToolsetsState & { surfaceKey?: string }>({
    ...EMPTY_TOOLSETS,
  });
  const [spendState, setSpendState] = useState<SessionSpendState & { surfaceKey?: string }>({
    ...EMPTY_SESSION_SPEND,
  });
  const [groupsState, setGroupsState] = useState(EMPTY_GROUPS);
  const [newGroupVisible, setNewGroupVisible] = useState(false);
  const [newGroupBusy, setNewGroupBusy] = useState(false);
  const [newGroupError, setNewGroupError] = useState<string | undefined>();
  const draftThread = useMemo(
    () =>
      composerDraftThread({
        gatewayId: activeGateway?.id,
        surface,
        sessionId: currentSessionId,
      }),
    [activeGateway?.id, surface, currentSessionId],
  );
  const draft = draftThread ? readComposerDraft(drafts, draftThread) : '';
  const setDraft = useCallback(
    (text: string) => {
      if (!draftThread) return;
      setDrafts((prev) => applyComposerDraft(prev, draftThread, text));
      void saveComposerDraft(draftThread, text);
    },
    [draftThread],
  );
  useEffect(() => {
    if (!draftThread) return;
    const thread = draftThread;
    const key = composerDraftKey(thread);
    let cancelled = false;
    void loadComposerDraft(thread).then((text) => {
      if (cancelled) return;
      setDrafts((prev) => {
        if (prev[key] !== undefined) return prev;
        return applyComposerDraft(prev, thread, text);
      });
    });
    return () => {
      cancelled = true;
    };
  }, [draftThread]);
  const { parallaxY, onScroll } = useAmbientParallaxScroll();
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const pinnedRef = useRef(true);
  const atTopRef = useRef(true);
  const jumpVisibleRef = useRef(false);

  // Every surface change funnels through here so the screen-local backends
  // section cannot outlive the configurable thread it belongs to (rook
  // 2026-08-24): navigating to a bot room, group room or the roster closes
  // it together with everything else that thread owned. Provider-owned
  // session/model flags are untouched — they stay valid on every surface.
  const showSurface = useCallback((next: ChatSurface) => {
    setBackendPickerVisible(false);
    setSurface(next);
  }, []);

  const pairingKey = `${deviceId ?? ''}:${pairingDetails?.requestId ?? ''}`;
  const isStreaming = isSending || messages.some((message) => message.streaming);
  const showPairingSheet = status === 'pairing' && !!deviceId && dismissedPairingKey !== pairingKey;
  const slashSuggestions = draft.trimStart().startsWith('/')
    ? getSlashCommandSuggestions(draft, activeHello, recentCommands, capabilitySnapshot.methods, dynamicCommands)
    : [];

  // The palette browses the whole surface, so it asks for an uncapped list --
  // the composer strip's 12-row cap is what makes discovery impossible.
  const allCommands = useMemo(
    () =>
      getSlashCommandSuggestions(
        '',
        activeHello,
        recentCommands,
        capabilitySnapshot.methods,
        dynamicCommands,
        Number.POSITIVE_INFINITY,
      ),
    [activeHello, recentCommands, capabilitySnapshot.methods, dynamicCommands],
  );

  const sessions = (sessionList as SessionRecord[]).map(toSessionItem);
  const currentSession = sessions.find((session) => session.id === currentSessionId);
  const sessionStats: ChatSessionStats | null = currentSession
    ? {
        title: currentSession.title,
        messageCount: currentSession.numMessages,
        totalTokens: currentSession.totalTokens,
        costUsd: currentSession.costUsd,
        lastActive: currentSession.updatedAt,
      }
    : null;

  const sessionLabel = currentSession?.title ?? (currentSessionId ? `${currentSessionId.slice(0, 10)}…` : undefined);
  // A Bot with no explicit pick answers on the model its Hermes profile
  // carries, so name that rather than falling back to a generic label — and
  // never to configurable chat's model, which is not what this thread runs on.
  const botOwnModel = selectedBotId
    ? rosterRows.find(
        (row): row is Extract<RosterRow, { kind: 'bot' }> =>
          row.kind === 'bot' && row.bot.id === selectedBotId,
      )?.bot.model?.default ?? undefined
    : undefined;
  const modelLabel =
    effectiveModel(activeGateway, selectedBackendId, selectedBotId) ?? botOwnModel ?? 'Default model';
  const identity = settings.pcName ?? activeGateway?.name;
  // Only the backend actually routing this thread. The `?? backends[0]`
  // fallback that used to be here labelled the chip "Claude Code" whenever the
  // selection had not resolved — the same lie the Gate setup screen told, and
  // the reason the UI could not be trusted about what a send would hit.
  const activeBackend = backends.find((backend) => backend.id === selectedBackendId);
  const backendLabel = activeBackend?.label;

  // One consolidated thread-config sheet (roadmap 2.2): sessions, models and
    // backends share a single host. Visibility stays owned where it always was —
    // provider modelPicker/sessionSelector flags plus the screen-local backend
    // flag — and the sheet renders whichever section they resolve to. The
    // offered modes come from the same pure contract (thread-config.ts) the
    // jest pins test, so mode and options cannot silently disagree.
    const threadConfigMode = resolveThreadConfigMode({
      sessionsVisible: sessionSelector.visible,
      modelsVisible: modelPicker.visible,
      backendsVisible: backendPickerVisible,
    });
    const threadConfigModes = useMemo<ThreadConfigMode[]>(
      () =>
        threadConfigOfferedModes({
          backendsVisible: backendPickerVisible,
          surfaceKind: surface.kind,
          backendsCount: backends.length,
        }),
      [backendPickerVisible, surface.kind, backends.length],
    );

  const handleThreadConfigSwitch = useCallback(
    (next: ThreadConfigMode) => {
      // Hop sections without dismissing: close whichever is open, open the
      // next. The openers fetch first, so the sheet re-lands with fresh data.
      if (next === 'models') {
        closeSessionSelector();
        setBackendPickerVisible(false);
        void openModelPicker('default');
      } else if (next === 'sessions') {
        closeModelPicker();
        setBackendPickerVisible(false);
        void openSessionSelector();
      } else {
        closeModelPicker();
        closeSessionSelector();
        setBackendPickerVisible(true);
      }
    },
    [closeModelPicker, closeSessionSelector, openModelPicker, openSessionSelector],
  );

  const handleSend = useCallback(async () => {
    const text = draft;
    if (!text.trim()) return;
    setDraft('');
    pinnedRef.current = true;
    await sendChatInput(text);
    requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
  }, [draft, sendChatInput, setDraft]);

  const handleResumeMessage = useCallback(
    (message: ChatMessage) => {
      const idx = messages.findIndex((m) => m.id === message.id);
      const previousUser = messages.slice(0, idx).reverse().find((m) => m.role === 'user');
      if (previousUser?.text.trim()) {
        void sendChatInput(previousUser.text.trim());
      }
    },
    [messages, sendChatInput],
  );

  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    onScroll(event);
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distanceFromBottom = contentSize.height - contentOffset.y - layoutMeasurement.height;
    pinnedRef.current = distanceFromBottom < PIN_THRESHOLD_PX;
    atTopRef.current = contentOffset.y <= AT_TOP_PX;
    const shouldShowJump = distanceFromBottom > JUMP_PILL_THRESHOLD_PX;
    if (shouldShowJump !== jumpVisibleRef.current) {
      jumpVisibleRef.current = shouldShowJump;
      setJumpVisible(shouldShowJump);
    }
  }, [onScroll]);

  const handleContentSizeChange = useCallback(() => {
    if (pinnedRef.current) {
      listRef.current?.scrollToEnd({ animated: true });
    }
  }, []);

  const scrollToLatest = useCallback(() => {
    pinnedRef.current = true;
    listRef.current?.scrollToEnd({ animated: true });
  }, []);

  useEffect(() => {
    if (surface.kind !== 'roster' || status !== 'connected') return;
    let cancelled = false;
    void listBots()
      .then((bots) => {
        if (cancelled) return;
        setRosterRows(buildRoster(bots));
        setRosterError(undefined);
        setRosterLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setRosterError(error instanceof Error ? error.message : String(error));
        setRosterRows([{ kind: 'configurable' }]);
        setRosterLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [surface.kind, status, listBots]);

  const botSurfaceId = surface.kind === 'bot' ? surface.botId : undefined;
  const spendSurfaceKey =
    surface.kind === 'bot'
      ? `bot:${surface.botId}`
      : surface.kind === 'configurable'
        ? `cfg:${selectedBackendId ?? ''}`
        : undefined;
  const toolsSurfaceKey = toolsetsVisibleOn(surface)
    ? surface.kind === 'configurable'
      ? `cfg:${selectedBackendId ?? ''}`
      : `bot:${surface.kind === 'bot' ? surface.botId : ''}`
    : undefined;
  const foldRoutineRead = useCallback((botId: string, read: RoutineRead) => {
    setRoutineState((prev) => {
      const previous = prev.botId === botId ? prev : { ...EMPTY_ROUTINES, botId };
      return { botId, ...applyRoutineRead(previous, read) };
    });
  }, []);
  useEffect(() => {
    if (!botSurfaceId || status !== 'connected') return;
    let cancelled = false;
    void botJobs
      .list()
      .then((jobs) => {
        if (cancelled) return;
        foldRoutineRead(botSurfaceId, { ok: true, jobs });
      })
      .catch(() => {
        if (cancelled) return;
        foldRoutineRead(botSurfaceId, { ok: false });
      });
    return () => {
      cancelled = true;
    };
  }, [botSurfaceId, status, botJobs, foldRoutineRead]);

  useEffect(() => {
    if (!botSurfaceId || status !== 'connected') return;
    let cancelled = false;
    void gatewayRequest('skills.list')
      .then((payload) => {
        if (cancelled) return;
        const read = skillsReadFromUnknown(payload);
        setSkillsState((prev) => {
          const previous =
            prev.botId === botSurfaceId ? prev : { ...EMPTY_SKILLS, botId: botSurfaceId };
          return { botId: botSurfaceId, ...applySkillsRead(previous, read) };
        });
      })
      .catch(() => {
        if (cancelled) return;
        setSkillsState((prev) => {
          const previous =
            prev.botId === botSurfaceId ? prev : { ...EMPTY_SKILLS, botId: botSurfaceId };
          return { botId: botSurfaceId, ...applySkillsRead(previous, { ok: false }) };
        });
      });
    return () => {
      cancelled = true;
    };
  }, [botSurfaceId, status, gatewayRequest]);

  useEffect(() => {
    if (!toolsSurfaceKey || status !== 'connected') return;
    let cancelled = false;
    void gatewayRequest('tools.list', toolsetsListParams({
      surfaceKind: surface.kind,
      backendId: selectedBackendId,
    }))
      .then((payload) => {
        if (cancelled) return;
        const read = toolsetsReadFromUnknown(payload);
        setToolsetsState((prev) => {
          const previous =
            prev.surfaceKey === toolsSurfaceKey
              ? prev
              : { ...EMPTY_TOOLSETS, surfaceKey: toolsSurfaceKey };
          return { surfaceKey: toolsSurfaceKey, ...applyToolsetsRead(previous, read) };
        });
      })
      .catch(() => {
        if (cancelled) return;
        setToolsetsState((prev) => {
          const previous =
            prev.surfaceKey === toolsSurfaceKey
              ? prev
              : { ...EMPTY_TOOLSETS, surfaceKey: toolsSurfaceKey };
          return { surfaceKey: toolsSurfaceKey, ...applyToolsetsRead(previous, { ok: false }) };
        });
      });
    return () => {
      cancelled = true;
    };
  }, [toolsSurfaceKey, status, surface.kind, selectedBackendId, gatewayRequest]);

  useEffect(() => {
    if (!spendSurfaceKey || status !== 'connected') return;
    let cancelled = false;
    void gatewayRequest('sessions.list', { limit: 50 })
      .then((payload) => {
        if (cancelled) return;
        const read = sessionSpendReadFromUnknown(payload);
        setSpendState((prev) => {
          const previous =
            prev.surfaceKey === spendSurfaceKey
              ? prev
              : { ...EMPTY_SESSION_SPEND, surfaceKey: spendSurfaceKey };
          return { surfaceKey: spendSurfaceKey, ...applySessionSpendRead(previous, read) };
        });
      })
      .catch(() => {
        if (cancelled) return;
        setSpendState((prev) => {
          const previous =
            prev.surfaceKey === spendSurfaceKey
              ? prev
              : { ...EMPTY_SESSION_SPEND, surfaceKey: spendSurfaceKey };
          return { surfaceKey: spendSurfaceKey, ...applySessionSpendRead(previous, { ok: false }) };
        });
      });
    return () => {
      cancelled = true;
    };
  }, [spendSurfaceKey, status, currentSessionId, gatewayRequest]);

  // Group rooms load alongside the roster. A gateway that does not advertise
  // them answers with an empty list — no error, just no section.
  const groupsOnRoster = surface.kind === 'roster';
  const refreshGroups = useCallback(() => {
    return botGroups
      .list()
      .then((rooms) => {
        setGroupsState((previous) => applyGroupRead(previous, { ok: true, rooms }));
        return rooms;
      })
      .catch(() => {
        setGroupsState((previous) => applyGroupRead(previous, { ok: false }));
        return [] as BotGroupRoom[];
      });
  }, [botGroups]);

  useEffect(() => {
    // refreshGroups stores the rooms itself; React ignores a store after
    // unmount, so no cancellation plumbing is needed here.
    if (!groupsOnRoster || status !== 'connected') return;
    void refreshGroups();
  }, [groupsOnRoster, status, refreshGroups]);

  // Pull-to-refresh on the roster: re-read BOTH inventories — agents and
  // rooms — without leaving the surface. A failed RE-read never wipes rows
  // the operator was just looking at (applyRosterRead / applyGroupRead keep
  // the last good inventory; the error line explains the staleness). Only a
  // SUCCESSFUL read may clear or replace the list.
  const refreshRoster = useCallback(async () => {
    const [read] = await Promise.all([
      listBots()
        .then((bots) => ({ ok: true as const, bots }))
        .catch((refreshError: unknown) => ({
          ok: false as const,
          reason: refreshError instanceof Error ? refreshError.message : String(refreshError),
        })),
      refreshGroups(),
    ]);
    setRosterRows((previous) => applyRosterRead(previous, read));
    if (read.ok) setRosterError(undefined);
    else setRosterError(read.reason);
  }, [listBots, refreshGroups]);

  const rosterBots = useMemo(
    () =>
      rosterRows.flatMap((row) => (row.kind === 'bot' ? [row.bot] : [])),
    [rosterRows],
  );

  // Verified-inventory honesty, ONE source for every surface that draws
  // routing/addable verdicts from the roster: the room view's plan/outcome
  // lines AND both member pickers. A completed, error-free read verifies
  // (even at zero bots — an empty gateway is a fact); a FAILED read
  // verifies nothing, so pickers say the roster is unread instead of
  // claiming exhaustion from zero knowledge (rook 2026-08-24T20:51;
  // B10 2026-08-26).
  const inventoryLoaded = rosterInventoryVerified({
    loading: rosterLoading,
    error: rosterError,
    botCount: rosterBots.length,
  });
  const openGroup = surface.kind === 'group'
    ? resolveOpenGroup(surface.groupId, groupsState)
    : undefined;
  const activeGroup = openGroup?.kind === 'open' ? openGroup.room : undefined;
  // Thread surfaces ride the provider message pipeline; a group room and the
  // roster do not (the room owns its transcript locally).
  const threadSurface = surface.kind === 'configurable' || surface.kind === 'bot';

  // Pull-to-refresh at the top pages back into earlier history when the
  // gateway reports more (the natural "more messages" gesture — the explicit
  // header control stays as a fallback). Anywhere else, or when history is
  // exhausted or a page is already loading, it re-reads the current window.
  // `prependEarlier` id-dedupes the fold, so an overlapping pull cannot render
  // a message twice (same merge rule as group-room pull-to-refresh).
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    const started = Date.now();
    if (resolvePullRefreshAction({ atTop: atTopRef.current, hasMoreHistory, loadingEarlierHistory }) === 'earlier') {
      await loadEarlierMessages().catch(() => undefined);
    } else {
      await reloadHistory().catch(() => undefined);
    }
    const elapsed = Date.now() - started;
    if (elapsed < 400) await new Promise((resolve) => setTimeout(resolve, 400 - elapsed));
    setRefreshing(false);
  }, [hasMoreHistory, loadEarlierMessages, loadingEarlierHistory, reloadHistory]);

  const renderMessage = useCallback(
    ({ item, index }: { item: ChatMessage; index: number }) => {
      const previous = messages[index - 1];
      const label = item.timestamp ? formatDayDivider(item.timestamp) : undefined;
      const previousLabel = previous?.timestamp ? formatDayDivider(previous.timestamp) : undefined;
      return (
        <>
          {label && label !== previousLabel ? <DayDivider label={label} /> : null}
          <MessageBubble
            message={item}
            identity={identity}
            onRetry={retryCommand}
            onCancel={cancelCommand}
            onResume={handleResumeMessage}
            onLongPress={setActionMessage}
          />
        </>
      );
    },
    [cancelCommand, handleResumeMessage, identity, messages, retryCommand],
  );

  if (!activeGateway) {
    return (
      <Screen>
        <ChatEmptyState
          title="Not connected yet"
          description={
            lastError
              ? describeGatewayError(lastError)
              : connectionPhase === 'searching' || connectionPhase === 'connecting'
                ? probeMessage || 'Connecting automatically…'
                : 'Versutus will connect to your PC automatically. You can also tap below.'
          }
          onConnect={() => void retryAutoConnect()}
          onGoHome={() => router.replace('/')}
        />
      </Screen>
    );
  }

  return (
    <Screen parallaxY={parallaxY}>
      <ChatHeader
        gatewayName={settings.pcName ?? activeGateway.name}
        status={status}
        statusDetail={status === 'connected' ? undefined : statusDetail || probeMessage}
        streaming={isStreaming}
        sessionLabel={
          surface.kind === 'group'
            ? activeGroup?.name
            : threadSurface
              ? sessionLabel
              : undefined
        }
        modelLabel={threadSurface ? modelLabel : undefined}
        onSessionPress={threadSurface ? () => void openSessionSelector() : undefined}
        onModelPress={threadSurface ? () => openModelPicker('default') : undefined}
        onOverflowPress={threadSurface ? () => setOverflowVisible(true) : undefined}
        backendLabel={
          surface.kind === 'bot'
            ? rosterRows.find((row): row is Extract<RosterRow, { kind: 'bot' }> => row.kind === 'bot' && row.bot.id === surface.botId)?.bot.displayName
              ?? selectedBotId
            : surface.kind === 'configurable'
              ? backendLabel
              : undefined
        }
        onBackendPress={surface.kind === 'configurable' && backends.length > 0 ? () => setBackendPickerVisible(true) : undefined}
        onRosterPress={surface.kind === 'roster' ? undefined : () => {
          clearBot();
          showSurface({ kind: 'roster' });
        }}
      />

      <NewAgentSheet
        key={editingBot ? `edit-${editingBot.id}` : 'create'}
        visible={newAgentVisible}
        busy={newAgentBusy}
        error={newAgentError}
        initial={editingBot ? botToEditInput(editingBot) : undefined}
        onClose={() => {
          setNewAgentVisible(false);
          setEditingBot(null);
        }}
        onSubmit={(form) => {
          setNewAgentBusy(true);
          setNewAgentError(undefined);
          const target = editingBot;
          // Edit sends only what the form owns; the Gate leaves absent fields untouched.
          const request = target
            ? updateBot({ id: target.id, ...buildBotUpdatePatch(form) })
            : createBot(form);
          void request
            .then(async (bot) => {
              setNewAgentVisible(false);
              setEditingBot(null);
              const bots = await listBots();
              setRosterRows(buildRoster(bots));
              if (!target && bot.routable) {
                await openBot(bot.id);
                showSurface({ kind: 'bot', botId: bot.id });
              }
            })
            .catch((error: unknown) => {
              // Desktop-parity: a refused create or edit speaks verdict +
              // fix, not raw wire text — the new-agent sheet was the last
              // bots-stack surface still rendering the Gate's raw stderr.
              setNewAgentError(describeRoomError(error));
            })
            .finally(() => setNewAgentBusy(false));
        }}
      />

      <CreateGroupSheet
        // Keyed by visibility so every open remounts with clean fields —
        // a half-typed name from a cancelled attempt never leaks back in.
        key={newGroupVisible ? 'new-group-open' : 'new-group-closed'}
        visible={newGroupVisible}
        busy={newGroupBusy}
        error={newGroupError}
        bots={rosterBots}
        inventoryLoaded={inventoryLoaded}
        onClose={() => setNewGroupVisible(false)}
        onCreate={({ name, memberIds }) => {
          setNewGroupBusy(true);
          setNewGroupError(undefined);
          void botGroups
            .create({ name, memberIds })
            .then(async (room) => {
              setNewGroupVisible(false);
              await refreshGroups();
              showSurface({ kind: 'group', groupId: room.id });
            })
            .catch((error: unknown) => {
              // Desktop-parity: a refused create speaks verdict + fix, not
              // raw wire text (same rule as every other room surface).
              setNewGroupError(describeRoomError(error));
            })
            .finally(() => setNewGroupBusy(false));
        }}
      />

      <BotDetailSheet
        bot={detailBot}
        onClose={() => setDetailBot(null)}
        onMessage={
          detailBot
            ? () => {
                // Same path as tapping the roster row itself; the detail sheet
                // closes first so the chat owns the stage, and a failed open
                // falls back to the roster exactly like a row tap does.
                const id = detailBot.id;
                showSurface({ kind: 'bot', botId: id });
                setDetailBot(null);
                void openBot(id).catch(() => {
                  showSurface({ kind: 'roster' });
                });
              }
            : undefined
        }
        onEdit={
          detailBot && hasBotManagement
            ? () => {
                // Same prefill path as the overflow menu's Edit agent — one form,
                // two doors. The detail sheet closes so the form owns the stage.
                setNewAgentError(undefined);
                setEditingBot(detailBot);
                setNewAgentVisible(true);
                setDetailBot(null);
              }
            : undefined
        }
      />

      <GroupRoomActionSheet
        room={detailGroup}
        members={rosterBots}
        inventoryLoaded={inventoryLoaded}
        onClose={() => setDetailGroup(null)}
        onOpen={
          detailGroup
            ? () => {
                // Same path as tapping the roster row itself; the sheet
                // closes first so the room owns the stage.
                const id = detailGroup.id;
                showSurface({ kind: 'group', groupId: id });
                setDetailGroup(null);
              }
            : undefined
        }
        onRename={
          detailGroup
            ? (name) =>
                botGroups.rename(detailGroup.id, name).then((room) => {
                  // The Gate's answer is the truth: refresh the roster copy
                  // AND feed the returned room back so the open sheet shows
                  // the new name, not the stale snapshot.
                  setDetailGroup(room);
                  void refreshGroups();
                  return room;
                })
            : undefined
        }
        onDisband={
          detailGroup
            ? () =>
                botGroups.deleteGroup(detailGroup.id).then((result) => {
                  // The room is gone from the Gate; the roster copy is now
                  // authoritative.
                  void refreshGroups();
                  return result;
                })
            : undefined
        }
        onAddMembers={
          detailGroup
            ? (memberIds) =>
                botGroups.addMembers(detailGroup.id, memberIds).then((room) => {
                  // The Gate's answer is the truth: feed the returned room
                  // back so the open sheet shows the joined roster, and
                  // refresh the roster copy behind it.
                  setDetailGroup(room);
                  void refreshGroups();
                  return room;
                })
            : undefined
        }
        onRemoveMember={
          detailGroup
            ? (memberId) =>
                botGroups.leave(detailGroup.id, memberId).then((room) => {
                  // The Gate's answer is the truth: feed the returned room
                  // back so the open sheet shows the shrunken roster, and
                  // refresh the roster copy behind it.
                  setDetailGroup(room);
                  void refreshGroups();
                  return room;
                })
            : undefined
        }
      />

      <PairingSheet
        visible={showPairingSheet}
        deviceId={deviceId ?? ''}
        pairingDetails={pairingDetails}
        onDismiss={() => setDismissedPairingKey(pairingKey)}
      />

      {lastError ? (
        <Animated.View entering={FadeIn.duration(Motion.duration.fast)} style={styles.bannerWrap}>
          <ErrorCard
            {...humanizeGatewayError(lastError)}
            retryLabel="Reconnect gateway"
            onRetry={() => void retryAutoConnect()}
          />
        </Animated.View>
      ) : null}

      {threadSurface ? (
        <ThreadSpendGlance
          copy={
            spendState.surfaceKey === spendSurfaceKey
              ? threadSpendCopy(spendState, currentSessionId)
              : undefined
          }
        />
      ) : null}

      {surface.kind === 'bot' ? (
        <SkillsPane
          skills={skillsState.botId === surface.botId ? skillsState.skills : []}
          loaded={skillsState.botId === surface.botId ? skillsState.loaded : false}
          failed={skillsState.botId === surface.botId ? skillsState.failed : false}
        />
      ) : null}

      {toolsetsVisibleOn(surface) ? (
        <ToolsPane
          toolsets={toolsetsState.surfaceKey === toolsSurfaceKey ? toolsetsState.toolsets : []}
          loaded={toolsetsState.surfaceKey === toolsSurfaceKey ? toolsetsState.loaded : false}
          failed={toolsetsState.surfaceKey === toolsSurfaceKey ? toolsetsState.failed : false}
        />
      ) : null}

      {surface.kind === 'bot' ? (
        <RoutinesPane
          jobs={routineState.botId === surface.botId ? routineState.jobs : []}
          loaded={routineState.botId === surface.botId ? routineState.loaded : false}
          failed={routineState.botId === surface.botId ? routineState.failed : false}
          onCreate={async (input) => {
            await botJobs.create({
              name: routineName(surface.botId, input.title),
              prompt: input.prompt,
              schedule: input.schedule,
            });
            // Create already landed; a failed re-list must not look like
            // the Gate refused the job (that would keep the draft of a
            // routine that exists). Last-good stays; staleness is named.
            await botJobs
              .list()
              .then((jobs) => foldRoutineRead(surface.botId, { ok: true, jobs }))
              .catch(() => foldRoutineRead(surface.botId, { ok: false }));
          }}
          onRun={async (jobId) => {
            await botJobs.run(jobId);
          }}
          onTogglePause={async (jobId, paused) => {
            await botJobs.pause(jobId, paused);
            await botJobs
              .list()
              .then((jobs) => foldRoutineRead(surface.botId, { ok: true, jobs }))
              .catch(() => foldRoutineRead(surface.botId, { ok: false }));
          }}
        />
      ) : null}

      {surface.kind === 'roster' ? (
        <ChatRoster
          rows={rosterRows}
          loading={rosterLoading && status === 'connected'}
          error={rosterError}
          groups={groupsState.rooms}
          groupsError={groupsListCopy(groupsState)}
          onSelectConfigurable={() => {
            clearBot();
            showSurface({ kind: 'configurable' });
          }}
          onSelectBot={(bot) => {
            showSurface({ kind: 'bot', botId: bot.id });
            void openBot(bot.id).catch(() => {
              showSurface({ kind: 'roster' });
            });
          }}
          onBotDetail={setDetailBot}
          onSelectGroup={(group) => {
            showSurface({ kind: 'group', groupId: group.id });
          }}
          onGroupDetail={setDetailGroup}
          // Honesty gating: gateways whose client cannot manage agents or
          // host rooms never see these rows at all — the refusal must not
          // wait until after the operator fills the sheet. The same verdicts
          // feed the roster's capability notes, so a shrunken roster still
          // says why instead of just being smaller.
          onNewAgent={hasBotManagement ? () => {
            setNewAgentError(undefined);
            setEditingBot(null);
            setNewAgentVisible(true);
          } : undefined}
          onNewGroup={status === 'connected' && hasGroupRooms ? () => {
            setNewGroupError(undefined);
            setNewGroupVisible(true);
          } : undefined}
          canManageAgents={hasBotManagement}
          canHostGroups={status === 'connected' && hasGroupRooms}
          onRefresh={status === 'connected' ? refreshRoster : undefined}
        />
      ) : surface.kind === 'group' ? (
        <View style={styles.listWrap}>
          {activeGroup ? (
            <GroupRoomView
                          key={activeGroup.id}
                          group={activeGroup}
                          members={rosterBots}
                          // Verified-inventory honesty: only a completed, error-free read
                          // counts, plus rows that survive from an earlier success. A FAILED
                          // read verifies nothing even though its spinner stopped — the room
                          // names the unread roster instead of asserting routing verdicts
                          // from zero knowledge (rook 2026-08-24T20:51).
                          inventoryLoaded={inventoryLoaded}
                          onSend={(text, mentionedIds) => botGroups.send(activeGroup.id, { text, mentionedIds })}
              loadHistory={() => botGroups.history(activeGroup.id)}
              onRename={(name) =>
                botGroups.rename(activeGroup.id, name).then((room) => {
                  void refreshGroups();
                  return room;
                })
              }
              onLeave={(memberId) =>
                botGroups.leave(activeGroup.id, memberId).then((room) => {
                  void refreshGroups();
                  // Leaving may drop the room to the two-member floor on an
                  // older Gate that has no floor guard; either way the roster
                  // copy is now authoritative.
                  return room;
                })
              }
              onDisband={() =>
                botGroups.deleteGroup(activeGroup.id).then((result) => {
                  void refreshGroups();
                  // The room is gone from the Gate; the roster copy is now
                  // authoritative, so leave the room surface behind.
                  showSurface({ kind: 'roster' });
                  return result;
                })
              }
            />
          ) : (
            <EmptyState
              icon={{ ios: 'person.3', android: 'groups', web: 'groups' }}
              title={openGroup?.kind === 'unread' ? 'Rooms could not be read' : 'This room is gone'}
              description={
                openGroup?.kind === 'unread'
                  ? "The Gate's group rooms could not be listed. The room may still be there."
                  : 'The Gate no longer lists this group room.'
              }
              actionLabel="Back to the roster"
              onAction={() => showSurface({ kind: 'roster' })}
            />
          )}
        </View>
      ) : (
      <View style={styles.listWrap}>
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(item) => item.id}
          style={styles.list}
          contentContainerStyle={styles.messages}
          onScroll={handleScroll}
          scrollEventThrottle={16}
          onContentSizeChange={handleContentSizeChange}
          renderItem={renderMessage}
          ListHeaderComponent={
            hasMoreHistory && messages.length > 0 ? (
              <View style={styles.loadEarlierWrap}>
                <Button
                  label={loadingEarlierHistory ? 'Loading…' : 'Load earlier messages'}
                  variant="ghost"
                  size="sm"
                  disabled={loadingEarlierHistory}
                  onPress={() => void loadEarlierMessages()}
                />
              </View>
            ) : null
          }
          ListEmptyComponent={
            historyLoading ? (
              <ChatSkeleton />
            ) : (
              <EmptyState
                icon={{ ios: 'bubble.left.and.bubble.right', android: 'chat', web: 'chat' }}
                title={status === 'connected' ? 'Say hello to your agent' : 'Waiting for connection'}
                description={
                  status === 'connected'
                    ? 'Type /help to explore your gateway — /run for agentic tasks.'
                    : 'The chat goes live as soon as the gateway connects.'
                }
              />
            )
          }
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => void onRefresh()}
              tintColor={tokens.accentWarm}
              colors={[tokens.accentWarm]}
              progressBackgroundColor={tokens.backgroundElevated}
            />
          }
        />

        {jumpVisible ? (
          <Animated.View entering={FadeIn.duration(Motion.duration.fast)} style={styles.jumpWrap}>
            <PressableScale
              onPress={scrollToLatest}
              accessibilityRole="button"
              accessibilityLabel="Scroll to latest message"
              style={[
                styles.jumpPill,
                { backgroundColor: tokens.backgroundRaised, borderColor: tokens.glassBorder },
              ]}>
              <Icon name={{ ios: 'arrow.down', android: 'arrow_downward', web: 'arrow_downward' }} size={13} color="accentWarm" />
              <Text variant="micro" color="accentWarm">
                Latest
              </Text>
            </PressableScale>
          </Animated.View>
        ) : null}
      </View>

      )}

      {threadSurface ? (
      <ChatComposer
        draft={draft}
        onChangeText={setDraft}
        onSend={() => void handleSend()}
        onStop={() => void stopStreaming()}
        onRefresh={() => void reloadHistory()}
        onReconnect={() => void retryAutoConnect()}
        slashSuggestions={slashSuggestions}
        onSelectSlashSuggestion={(value) => setDraft(value)}
        onBrowseCommands={() => setPaletteVisible(true)}
        quickActions={[
          { label: 'Run', draft: '/run ', icon: { ios: 'bolt.fill', android: 'bolt', web: 'bolt' } },
          { label: 'Status', draft: '/status', icon: { ios: 'waveform.path.ecg', android: 'pulse', web: 'pulse' } },
          { label: 'Help', draft: '/help', icon: { ios: 'questionmark.circle', android: 'help', web: 'help' } },
        ]}
        isStreaming={isStreaming}
        status={status}
        // Allow send while disconnected so the offline outbox can queue; the
        // provider flushes on reconnect. Block only when no gateway exists.
        canSend={!!activeGateway && !isCommandRunning}
      />
      ) : null}

      <SlashCommandPalette
        visible={paletteVisible}
        commands={allCommands}
        // Opening from the `/` strip carries the partial command across, so the
        // palette lands already filtered to what the user was typing.
        initialQuery={draft.trimStart().startsWith('/') ? draft : ''}
        onClose={() => setPaletteVisible(false)}
        onSelect={(value) => setDraft(value)}
      />

      <ConfirmationSheet
        visible={!!pendingConfirmation}
        preview={pendingConfirmation}
        onConfirm={() => void confirmPendingAction()}
        onCancel={() => void cancelPendingConfirmation()}
      />

      <ApprovalSheet
        visible={!!pendingRunApproval}
        runId={pendingRunApproval?.runId}
        prompt={pendingRunApproval?.prompt}
        gatewayName={settings.pcName ?? activeGateway.name}
        onApprove={(feedback) => resolveRunApproval(true, feedback)}
        onDeny={(feedback) => resolveRunApproval(false, feedback)}
      />

      <ChatOverflowSheet
        visible={overflowVisible}
        onClose={() => setOverflowVisible(false)}
        session={sessionStats}
        sessions={sessionList}
        onReloadHistory={() => void reloadHistory()}
        onNewSession={() => void createNewSession()}
        onDisconnect={disconnectGateway}
        runsSupported={
          capabilitySnapshot.groups.find((group) => group.id === 'agent')?.status === 'ready'
        }
        onStartRun={() => {
          setDraft('/run ');
          setOverflowVisible(false);
        }}
        onEditAgent={
          surface.kind === 'bot' && hasBotManagement
            ? () => {
                const row = rosterRows.find(
                  (candidate): candidate is Extract<RosterRow, { kind: 'bot' }> =>
                    candidate.kind === 'bot' && candidate.bot.id === surface.botId,
                );
                if (!row) return;
                setNewAgentError(undefined);
                setEditingBot(row.bot);
                setNewAgentVisible(true);
              }
            : undefined
        }
      />

      <MessageActionsSheet
        visible={!!actionMessage}
        message={actionMessage}
        onClose={() => setActionMessage(null)}
        onRetry={retryCommand}
        onDelete={deleteLocalMessage}
      />

      <ThreadConfigSheet
        mode={threadConfigMode}
        availableModes={threadConfigModes}
        onModeChange={handleThreadConfigSwitch}
        onClose={() => {
          closeModelPicker();
          closeSessionSelector();
          setBackendPickerVisible(false);
        }}
        sessions={sessions}
        sessionsError={sessionListError}
        currentSessionId={currentSessionId}
        onSelectSession={selectSession}
        onRefreshSessions={() => void openSessionSelector()}
        onNewSession={() => void createNewSession()}
        onDeleteSession={(sessionId) => void deleteSessionById(sessionId)}
        models={modelCatalog.map((model: Record<string, unknown>) => ({
          id: String(model.id || model.model || model.name || ''),
          provider: model.provider as string | undefined,
          providerId: (model.providerId ?? model.provider) as string | undefined,
          catalogState: (model.catalogSource ?? model.catalogState) as string | undefined,
          available: model.available !== false,
          context: (model.context ?? model.contextLength) as number | undefined,
          price: (model.cost ?? model.price) as number | undefined,
          auth: (model.authStatus ?? model.auth) as string | undefined,
          usage: model.usage as string | undefined,
        }))}
        currentModel={activeGateway.model}
        modelMode={modelPicker.mode}
        modelAgentId={modelPicker.agentId}
        onSelectModel={selectModel}
        onRefreshModels={() => {
          closeModelPicker();
          void openModelPicker(modelPicker.mode, modelPicker.agentId);
        }}
        backends={backends}
        selectedBackendId={activeBackend?.id}
        onSelectBackend={selectBackend}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  bannerWrap: {
    marginHorizontal: Spacing.four,
    marginBottom: Spacing.two,
  },
  listWrap: {
    flex: 1,
    position: 'relative',
  },
  list: {
    flex: 1,
  },
  loadEarlierWrap: {
    alignItems: 'center',
    paddingVertical: Spacing.two,
  },
  messages: {
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.two,
    gap: Spacing.two,
    flexGrow: 1,
  },
  jumpWrap: {
    position: 'absolute',
    right: Spacing.four,
    bottom: Spacing.two,
  },
  jumpPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.three - 4,
    paddingVertical: Spacing.one + 2,
    borderRadius: Radius.full,
    borderWidth: StyleSheet.hairlineWidth,
  },
  skeletonWrap: {
    flex: 1,
    justifyContent: 'center',
    gap: Spacing.three,
    paddingVertical: Spacing.five,
  },
  skeletonLeft: {
    alignSelf: 'flex-start',
  },
  skeletonRight: {
    alignSelf: 'flex-end',
  },
});

