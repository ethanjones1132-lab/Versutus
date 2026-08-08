import { useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';

import { ChatComposer } from '@/components/chat/chat-composer';
import { ChatEmptyState } from '@/components/chat/chat-empty-state';
import { MessageBubble } from '@/components/chat/message-bubble';
import { PairingSheet } from '@/components/chat/pairing-sheet';
import { ConfirmationSheet } from '@/components/chat/confirmation-sheet';
import { ApprovalSheet } from '@/components/chat/approval-sheet';
import { ModelPickerSheet } from '@/components/chat/model-picker-sheet';
import { SessionSelectorSheet } from '@/components/chat/session-selector-sheet';
import { ConnectionBadge } from '@/components/connection-badge';
import { Card, Screen, Text } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import { getSlashCommandSuggestions } from '@/lib/gateway/slash-commands';
import type { ChatMessage } from '@/lib/gateway/types';
export default function ChatScreen() {
  const router = useRouter();
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
  } = useGateway();
  const [draft, setDraft] = useState('');
  const [dismissedPairingKey, setDismissedPairingKey] = useState<string | null>(null);
  const listRef = useRef<FlatList<ChatMessage>>(null);

  const pairingKey = `${deviceId ?? ''}:${pairingDetails?.requestId ?? ''}`;
  const isStreaming = isSending || messages.some((message) => message.streaming);
  const showPairingSheet = status === 'pairing' && !!deviceId && dismissedPairingKey !== pairingKey;
  const slashSuggestions = draft.trimStart().startsWith('/')
    ? getSlashCommandSuggestions(draft, activeHello, recentCommands)
    : [];

  const handleSend = useCallback(async () => {
    const text = draft;
    if (!text.trim()) return;
    setDraft('');
    await sendChatInput(text);
    requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
  }, [draft, sendChatInput]);

  if (!activeGateway) {
    return (
      <Screen>
        <ChatEmptyState
          title="Not connected yet"
          description={
            lastError 
              ? `Cause: ${lastError}. Target: connection to gateway. Next: tap Connect or check Tailscale.`
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
    <Screen edges={['bottom']}>
      <View style={styles.headerWrap}>
        <Card padding={Spacing.three} style={styles.headerCard}>
          <View style={styles.headerText}>
            <Text variant="caption" color="accentWarm" style={styles.headerKicker}>
              Active gateway
            </Text>
            <Text variant="headline" numberOfLines={1}>
              {settings.pcName ?? activeGateway.name}
            </Text>
            <Text color="secondary" variant="caption" numberOfLines={1}>
              {status === 'connected' ? 'Ready for chat and slash commands' : statusDetail || probeMessage}
            </Text>
          </View>
          <ConnectionBadge status={status} />
        </Card>
      </View>

      <PairingSheet
        visible={showPairingSheet}
        deviceId={deviceId ?? ''}
        pairingDetails={pairingDetails}
        onDismiss={() => setDismissedPairingKey(pairingKey)}
      />

      {lastError ? (
        <Card variant="inset" padding={Spacing.three} style={styles.banner}>
          <Text color="secondary" variant="caption">
            Cause: {lastError}. Affected: gateway connection. Next action: Retry or check your Tailscale/PC.
          </Text>
        </Card>
      ) : null}

      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(item) => item.id}
        style={styles.list}
        contentContainerStyle={styles.messages}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        renderItem={({ item }) => (
          <MessageBubble
            message={item}
            onRetry={retryCommand}
            onCancel={cancelCommand}
          />
        )}
        ListEmptyComponent={
          <View style={styles.emptyWrap}>
            <Text color="secondary" style={styles.emptyMessages}>
              {status === 'connected' ? 'Say hello to your agent.' : 'Waiting for connection…'}
            </Text>
            {status === 'connected' ? (
              <Text variant="caption" color="tertiary" style={styles.emptyHint}>
                Tip: type /help to explore your gateway — /run for agentic tasks.
              </Text>
            ) : null}
          </View>
        }
      />

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
        canSend={status === 'connected' && !isCommandRunning}
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

      <ModelPickerSheet
        visible={modelPicker.visible}
        models={modelCatalog.map((m: any) => ({
          id: m.id || m.model || m.name,
          provider: m.provider,
          available: m.available !== false,
          context: m.context || m.contextLength,
          price: m.cost || m.price,
          auth: m.authStatus || m.auth,
          usage: m.usage,
        }))}
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
        sessions={sessionList.map((s: any) => ({
          id: s.id || s.sessionId || s.name,
          title: s.title || s.name,
          status: s.status,
          numMessages: s.numMessages || s.messageCount,
          updatedAt: s.updatedAt,
        }))}
        currentSessionId={currentSessionId}
        onSelect={selectSession}
        onClose={closeSessionSelector}
        onRefresh={() => void openSessionSelector()}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  headerWrap: {
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.two,
    paddingBottom: Spacing.three,
  },
  headerCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
    borderRadius: Radius.xl,
  },
  headerText: {
    flex: 1,
    gap: Spacing.one,
  },
  headerKicker: {
    textTransform: 'uppercase',
  },
  banner: {
    marginHorizontal: Spacing.four,
    marginBottom: Spacing.two,
    borderRadius: Radius.md,
  },
  list: {
    flex: 1,
  },
  messages: {
    paddingHorizontal: Spacing.four,
    paddingBottom: Spacing.three,
    gap: Spacing.two,
    flexGrow: 1,
  },
  emptyMessages: {
    textAlign: 'center',
    marginTop: Spacing.six,
  },
  emptyWrap: {
    flexGrow: 1,
    justifyContent: 'center',
    gap: Spacing.one,
  },
  emptyHint: {
    textAlign: 'center',
  },
});
