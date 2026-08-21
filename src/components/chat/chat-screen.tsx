import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import { ApprovalSheet } from '@/components/chat/approval-sheet';
import { BackendPickerSheet } from '@/components/chat/backend-picker-sheet';
import { ChatComposer } from '@/components/chat/chat-composer';
import { ChatRoster } from '@/components/chat/chat-roster';
import { NewAgentSheet } from '@/components/chat/new-agent-sheet';
import { RoutinesPane, type RoutineJob } from '@/components/chat/routines-pane';
import { DayDivider } from '@/components/chat/day-divider';
import { ChatEmptyState } from '@/components/chat/chat-empty-state';
import { ChatHeader } from '@/components/chat/chat-header';
import { ChatOverflowSheet, type ChatSessionStats } from '@/components/chat/chat-overflow-sheet';
import { ConfirmationSheet } from '@/components/chat/confirmation-sheet';
import { MessageActionsSheet } from '@/components/chat/message-actions-sheet';
import { MessageBubble } from '@/components/chat/message-bubble';
import { ModelPickerSheet } from '@/components/chat/model-picker-sheet';
import { PairingSheet } from '@/components/chat/pairing-sheet';
import { SessionSelectorSheet, type SessionItem } from '@/components/chat/session-selector-sheet';
import { SlashCommandPalette } from '@/components/chat/slash-command-palette';
import { Button, EmptyState, ErrorCard, Icon, PressableScale, Screen, Skeleton, Text } from '@/components/ui';
import { Motion, Radius, Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import { describeGatewayError, humanizeGatewayError } from '@/lib/gateway/error-humanizer';
import { useTokens } from '@/hooks/use-tokens';
import { getSlashCommandSuggestions } from '@/lib/gateway/slash-commands';
import { formatDayDivider } from '@/lib/format';
import type { ChatMessage, HermesSession } from '@/lib/gateway/types';
import { buildRoster, type ChatSurface, type RosterRow } from '@/lib/gateway/bots';
import { routineName } from '@/lib/gateway/routines';
import { effectiveModel } from '@/lib/gateway/model-selection';
import { useAmbientParallaxScroll } from '@/lib/motion/ambient-parallax';

const PIN_THRESHOLD_PX = 96;
const JUMP_PILL_THRESHOLD_PX = 260;

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
    openBot,
    clearBot,
    botJobs,
    selectedBotId,
  } = useGateway();

  const [draft, setDraft] = useState('');
  const [dismissedPairingKey, setDismissedPairingKey] = useState<string | null>(null);
  const [overflowVisible, setOverflowVisible] = useState(false);
  const [backendPickerVisible, setBackendPickerVisible] = useState(false);
  const [paletteVisible, setPaletteVisible] = useState(false);
  const [actionMessage, setActionMessage] = useState<ChatMessage | null>(null);
  const [jumpVisible, setJumpVisible] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [surface, setSurface] = useState<ChatSurface>({ kind: 'roster' });
  const [rosterRows, setRosterRows] = useState<RosterRow[]>([{ kind: 'configurable' }]);
  const [rosterLoading, setRosterLoading] = useState(false);
  const [rosterError, setRosterError] = useState<string | undefined>();
  const [newAgentVisible, setNewAgentVisible] = useState(false);
  const [newAgentBusy, setNewAgentBusy] = useState(false);
  const [newAgentError, setNewAgentError] = useState<string | undefined>();
  const [routineJobs, setRoutineJobs] = useState<RoutineJob[]>([]);
  const { parallaxY, onScroll } = useAmbientParallaxScroll();
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const pinnedRef = useRef(true);
  const jumpVisibleRef = useRef(false);

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
  const modelLabel = effectiveModel(activeGateway, selectedBackendId, selectedBotId) ?? 'Default model';
  const identity = settings.pcName ?? activeGateway?.name;
  const activeBackend = backends.find((backend) => backend.id === selectedBackendId) ?? backends[0];
  const backendLabel = activeBackend?.label;

  const handleSend = useCallback(async () => {
    const text = draft;
    if (!text.trim()) return;
    setDraft('');
    pinnedRef.current = true;
    await sendChatInput(text);
    requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
  }, [draft, sendChatInput]);

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
  useEffect(() => {
    if (!botSurfaceId || status !== 'connected') return;
    let cancelled = false;
    void botJobs.list().then((jobs) => {
      if (!cancelled) setRoutineJobs(jobs);
    }).catch(() => {
      if (!cancelled) setRoutineJobs([]);
    });
    return () => {
      cancelled = true;
    };
  }, [botSurfaceId, status, botJobs]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    const started = Date.now();
    await reloadHistory().catch(() => undefined);
    const elapsed = Date.now() - started;
    if (elapsed < 400) await new Promise((resolve) => setTimeout(resolve, 400 - elapsed));
    setRefreshing(false);
  }, [reloadHistory]);

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
        sessionLabel={surface.kind === 'roster' ? undefined : sessionLabel}
        modelLabel={surface.kind === 'roster' ? undefined : modelLabel}
        onSessionPress={surface.kind === 'roster' ? undefined : () => void openSessionSelector()}
        onModelPress={surface.kind === 'roster' ? undefined : () => openModelPicker('default')}
        onOverflowPress={surface.kind === 'roster' ? undefined : () => setOverflowVisible(true)}
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
          setSurface({ kind: 'roster' });
        }}
      />

      <NewAgentSheet
        visible={newAgentVisible}
        busy={newAgentBusy}
        error={newAgentError}
        onClose={() => setNewAgentVisible(false)}
        onSubmit={(draft) => {
          setNewAgentBusy(true);
          setNewAgentError(undefined);
          void createBot(draft)
            .then(async (bot) => {
              setNewAgentVisible(false);
              const bots = await listBots();
              setRosterRows(buildRoster(bots));
              if (bot.routable) {
                await openBot(bot.id);
                setSurface({ kind: 'bot', botId: bot.id });
              }
            })
            .catch((error: unknown) => {
              setNewAgentError(error instanceof Error ? error.message : String(error));
            })
            .finally(() => setNewAgentBusy(false));
        }}
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

      {surface.kind === 'bot' ? (
        <RoutinesPane
          jobs={routineJobs}
          onCreate={(input) => {
            void botJobs
              .create({
                name: routineName(surface.botId, input.title),
                prompt: input.prompt,
                schedule: input.schedule,
              })
              .then(() => botJobs.list())
              .then(setRoutineJobs)
              .catch(() => undefined);
          }}
          onRun={(jobId) => {
            void botJobs.run(jobId).catch(() => undefined);
          }}
          onTogglePause={(jobId, paused) => {
            void botJobs
              .pause(jobId, paused)
              .then(() => botJobs.list())
              .then(setRoutineJobs)
              .catch(() => undefined);
          }}
        />
      ) : null}

      {surface.kind === 'roster' ? (
        <ChatRoster
          rows={rosterRows}
          loading={rosterLoading}
          error={rosterError}
          onSelectConfigurable={() => {
            clearBot();
            setSurface({ kind: 'configurable' });
          }}
          onSelectBot={(bot) => {
            setSurface({ kind: 'bot', botId: bot.id });
            void openBot(bot.id).catch(() => {
              setSurface({ kind: 'roster' });
            });
          }}
          onNewAgent={() => {
            setNewAgentError(undefined);
            setNewAgentVisible(true);
          }}
        />
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

      {surface.kind === 'roster' ? null : (
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
        // Allow send while disconnected so the offline outbox can queue; the
        // provider flushes on reconnect. Block only when no gateway exists.
        canSend={!!activeGateway && !isCommandRunning}
      />
      )}

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
      />

      <BackendPickerSheet
        visible={backendPickerVisible}
        backends={backends}
        selectedBackendId={activeBackend?.id}
        onSelect={selectBackend}
        onClose={() => setBackendPickerVisible(false)}
      />

      <MessageActionsSheet
        visible={!!actionMessage}
        message={actionMessage}
        onClose={() => setActionMessage(null)}
        onRetry={retryCommand}
        onDelete={deleteLocalMessage}
      />

      <ModelPickerSheet
        visible={modelPicker.visible}
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
        currentDefault={activeGateway.model}
        mode={modelPicker.mode}
        agentId={modelPicker.agentId}
        onSelect={selectModel}
        onClose={closeModelPicker}
        onRefresh={async () => {
          closeModelPicker();
          void openModelPicker(modelPicker.mode, modelPicker.agentId);
        }}
      />

      <SessionSelectorSheet
        visible={sessionSelector.visible}
        sessions={sessions}
        currentSessionId={currentSessionId}
        onSelect={selectSession}
        onClose={closeSessionSelector}
        onRefresh={() => void openSessionSelector()}
        onNewSession={() => void createNewSession()}
        onDeleteSession={(sessionId) => void deleteSessionById(sessionId)}
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

