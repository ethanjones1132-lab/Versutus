import { useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { FlatList, StyleSheet, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import { ApprovalSheet } from '@/components/chat/approval-sheet';
import { BackendPickerSheet } from '@/components/chat/backend-picker-sheet';
import { ChatComposer } from '@/components/chat/chat-composer';
import { ChatEmptyState } from '@/components/chat/chat-empty-state';
import { ChatHeader } from '@/components/chat/chat-header';
import { ChatOverflowSheet, type ChatSessionStats } from '@/components/chat/chat-overflow-sheet';
import { ConfirmationSheet } from '@/components/chat/confirmation-sheet';
import { MessageActionsSheet } from '@/components/chat/message-actions-sheet';
import { MessageBubble } from '@/components/chat/message-bubble';
import { ModelPickerSheet } from '@/components/chat/model-picker-sheet';
import { PairingSheet } from '@/components/chat/pairing-sheet';
import { SessionSelectorSheet, type SessionItem } from '@/components/chat/session-selector-sheet';
import { Button, EmptyState, ErrorCard, Icon, PressableScale, Screen, Skeleton, Text } from '@/components/ui';
import { Motion, Radius, Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import { useTokens } from '@/hooks/use-tokens';
import { getSlashCommandSuggestions } from '@/lib/gateway/slash-commands';
import type { ChatMessage, HermesSession } from '@/lib/gateway/types';

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
  } = useGateway();

  const [draft, setDraft] = useState('');
  const [dismissedPairingKey, setDismissedPairingKey] = useState<string | null>(null);
  const [overflowVisible, setOverflowVisible] = useState(false);
  const [backendPickerVisible, setBackendPickerVisible] = useState(false);
  const [actionMessage, setActionMessage] = useState<ChatMessage | null>(null);
  const [jumpVisible, setJumpVisible] = useState(false);
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const pinnedRef = useRef(true);
  const jumpVisibleRef = useRef(false);

  const pairingKey = `${deviceId ?? ''}:${pairingDetails?.requestId ?? ''}`;
  const isStreaming = isSending || messages.some((message) => message.streaming);
  const showPairingSheet = status === 'pairing' && !!deviceId && dismissedPairingKey !== pairingKey;
  const slashSuggestions = draft.trimStart().startsWith('/')
    ? getSlashCommandSuggestions(draft, activeHello, recentCommands, capabilitySnapshot.methods, dynamicCommands)
    : [];

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
  const modelLabel = activeGateway?.model ?? 'Default model';
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

  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distanceFromBottom = contentSize.height - contentOffset.y - layoutMeasurement.height;
    pinnedRef.current = distanceFromBottom < PIN_THRESHOLD_PX;
    const shouldShowJump = distanceFromBottom > JUMP_PILL_THRESHOLD_PX;
    if (shouldShowJump !== jumpVisibleRef.current) {
      jumpVisibleRef.current = shouldShowJump;
      setJumpVisible(shouldShowJump);
    }
  }, []);

  const handleContentSizeChange = useCallback(() => {
    if (pinnedRef.current) {
      listRef.current?.scrollToEnd({ animated: true });
    }
  }, []);

  const scrollToLatest = useCallback(() => {
    pinnedRef.current = true;
    listRef.current?.scrollToEnd({ animated: true });
  }, []);

  const renderMessage = useCallback(
    ({ item }: { item: ChatMessage }) => (
      <MessageBubble
        message={item}
        onRetry={retryCommand}
        onCancel={cancelCommand}
        onLongPress={setActionMessage}
      />
    ),
    [cancelCommand, retryCommand],
  );

  if (!activeGateway) {
    return (
      <Screen>
        <ChatEmptyState
          title="Not connected yet"
          description={
            lastError
              ? `Cause: ${lastError}. Affected: gateway connection. Next: tap Connect to gateway or check Tailscale.`
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
    <Screen edges={['bottom']} ambient={false}>
      <ChatHeader
        gatewayName={settings.pcName ?? activeGateway.name}
        status={status}
        statusDetail={status === 'connected' ? undefined : statusDetail || probeMessage}
        streaming={isStreaming}
        sessionLabel={sessionLabel}
        modelLabel={modelLabel}
        onSessionPress={() => void openSessionSelector()}
        onModelPress={() => openModelPicker('default')}
        onOverflowPress={() => setOverflowVisible(true)}
        backendLabel={backendLabel}
        onBackendPress={backends.length > 0 ? () => setBackendPickerVisible(true) : undefined}
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
            cause={lastError}
            affected="gateway connection"
            next="Reconnect gateway or check Tailscale/PC."
            retryLabel="Reconnect gateway"
            onRetry={() => void retryAutoConnect()}
          />
        </Animated.View>
      ) : null}

      <View style={styles.listWrap}>
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(item) => item.id}
          style={styles.list}
          contentContainerStyle={styles.messages}
          onScroll={handleScroll}
          scrollEventThrottle={80}
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
          removeClippedSubviews
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

      <ChatComposer
        draft={draft}
        onChangeText={setDraft}
        onSend={() => void handleSend()}
        onStop={() => void stopStreaming()}
        onRefresh={() => void reloadHistory()}
        onReconnect={() => void retryAutoConnect()}
        slashSuggestions={slashSuggestions}
        onSelectSlashSuggestion={(value) => setDraft(value)}
        isStreaming={isStreaming}
        // Allow send while disconnected so the offline outbox can queue; the
        // provider flushes on reconnect. Block only when no gateway exists.
        canSend={!!activeGateway && !isCommandRunning}
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
