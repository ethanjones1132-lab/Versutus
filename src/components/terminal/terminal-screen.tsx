import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { ChatEmptyState } from '@/components/chat/chat-empty-state';
import { ConnectionBadge } from '@/components/connection-badge';
import { GatewayCommandPanel } from '@/components/gateway/gateway-command-panel';
import { CommandLogSheet } from '@/components/terminal/command-log-sheet';
import { CommandResultView } from '@/components/terminal/command-result-view';
import { TerminalModePicker, type TerminalMode } from '@/components/terminal/mode-picker';
import { TerminalOutput } from '@/components/terminal/terminal-output';
import { Button, Card, Chip, EmptyState, ErrorCard, Screen, Text } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import { useTokens } from '@/hooks/use-tokens';
import {
  agentCommands,
  filterExecutableCommands,
  homeQuickCommands,
  summarizeCommandResult,
  type GatewayCommand,
} from '@/lib/gateway/dashboard';
import { useAmbientParallaxScroll } from '@/lib/motion/ambient-parallax';
import { appendTerminalChunk, type TerminalLine } from '@/lib/terminal/output';
import { openTerminalSession, sendTerminalInput, type TerminalSession } from '@/lib/terminal/client';

const HISTORY_LIMIT = 40;

export function TerminalScreen() {
  const router = useRouter();
  const tokens = useTokens();
  const {
    activeGateway,
    activeHello,
    status,
    statusDetail,
    settings,
    retryAutoConnect,
    gatewayRequest,
    runAgentCommand,
    capabilitySnapshot,
  } = useGateway();
  // Hermes exposes no terminal endpoint; attempting the stream just 404s and
  // surfaces as a connection error. Only offer the shell when advertised.
  const shellSupported =
    capabilitySnapshot.groups.find((group) => group.id === 'terminal')?.status === 'ready';
  // Default to RPC on Hermes-like gateways so Tools doesn't open on a dead shell.
  // Derive effective mode so unsupported shell never sticks without an effect.
  const [modePreference, setModePreference] = useState<TerminalMode>('rpc');
  const mode: TerminalMode =
    !shellSupported && modePreference === 'shell' ? 'rpc' : modePreference;
  const setMode = setModePreference;
  const [terminalLines, setTerminalLines] = useState<TerminalLine[]>([]);
  const [commandOutput, setCommandOutput] = useState('');
  const [input, setInput] = useState('');
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const [terminalConnected, setTerminalConnected] = useState(false);
  const [runningCommandId, setRunningCommandId] = useState<string | null>(null);
  const [commandLog, setCommandLog] = useState('');
  const [logSheetVisible, setLogSheetVisible] = useState(false);
  const { parallaxY, onScroll } = useAmbientParallaxScroll();
  const sessionRef = useRef<TerminalSession | null>(null);

  const appendOutput = useCallback((chunk: string) => {
    setTerminalLines((previous) => appendTerminalChunk(previous, chunk));
  }, []);

  const startTerminal = useCallback(async () => {
    if (!activeGateway || status !== 'connected' || !shellSupported) return;
    sessionRef.current?.close();
    sessionRef.current = null;
    setTerminalLines([]);
    setTerminalError(null);
    setTerminalConnected(false);

    try {
      const session = await openTerminalSession(
        activeGateway.url,
        {
          onOutput: appendOutput,
          onError: (message) => {
            setTerminalError(message);
            setTerminalConnected(false);
          },
          onExit: (code) => {
            appendOutput(`\n[exit ${code}]\n`);
            sessionRef.current = null;
            setTerminalConnected(false);
          },
        },
        activeGateway.token,
      );
      sessionRef.current = session;
      setTerminalConnected(true);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTerminalError(message);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  }, [activeGateway, appendOutput, shellSupported, status]);

  const gatewayId = activeGateway?.id ?? null;

  // Keep the shell session alive while switching between Shell/RPC/Agent. Only
  // gateway changes, connection loss, or unmount close the live session.
  useEffect(() => {
    return () => {
      sessionRef.current?.close();
      sessionRef.current = null;
    };
  }, [gatewayId, status]);

  useEffect(() => {
    if (gatewayId && status === 'connected' && shellSupported && mode === 'shell' && !sessionRef.current) {
      // Deliberately establish the session from the effect when the gateway is
      // ready; callbacks settle the connected state asynchronously.
      void startTerminal();
    }
  }, [gatewayId, mode, shellSupported, startTerminal, status]);

  const sendToTerminal = useCallback(async () => {
    const session = sessionRef.current;
    const gateway = activeGateway;
    const value = input.trimEnd();
    if (!session || !gateway || !value) return;
    const payload = value.endsWith('\n') ? value : `${value}\n`;
    setInput('');
    setHistoryIndex(-1);
    setInputHistory((previous) => [value, ...previous.filter((item) => item !== value)].slice(0, HISTORY_LIMIT));
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      await sendTerminalInput(gateway.url, session.sid, payload, gateway.token);
    } catch (error) {
      setTerminalError(error instanceof Error ? error.message : String(error));
    }
  }, [activeGateway, input]);

  const handleInputKeyPress = useCallback(
    (event: { nativeEvent: { key: string } }) => {
      if (event.nativeEvent.key === 'ArrowUp' && inputHistory.length > 0) {
        const nextIndex = Math.min(historyIndex + 1, inputHistory.length - 1);
        setHistoryIndex(nextIndex);
        setInput(inputHistory[nextIndex] ?? '');
      } else if (event.nativeEvent.key === 'ArrowDown' && historyIndex >= 0) {
        const nextIndex = historyIndex - 1;
        setHistoryIndex(nextIndex);
        setInput(nextIndex >= 0 ? inputHistory[nextIndex] ?? '' : '');
      }
    },
    [historyIndex, inputHistory],
  );

  const runGatewayCommand = useCallback(
    async (command: GatewayCommand) => {
      if (status !== 'connected') return;
      setRunningCommandId(command.id);
      setTerminalError(null);
      try {
        if (command.transport === 'agent') {
          const agentInput = command.agentCommand ?? command.slash ?? command.label;
          await runAgentCommand(agentInput);
          const summary = summarizeCommandResult(command, { ok: true });
          setCommandOutput(summary);
          setCommandLog(summary);
        } else {
          if (!command.method) throw new Error('Command has no RPC method');
          const result = await gatewayRequest(command.method, command.params ?? {});
          const summary = summarizeCommandResult(command, result);
          setCommandOutput(summary);
          setCommandLog(JSON.stringify(result, null, 2));
        }
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setTerminalError(message);
        setCommandOutput(`Command failed: ${message}`);
        setCommandLog(message);
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      } finally {
        setRunningCommandId(null);
      }
    },
    [gatewayRequest, runAgentCommand, status],
  );

  // One filter, keyed on what the connected gateway says it dispatches. The
  // old two-stage version guessed from the gateway's kind first, which emptied
  // this tab on any non-Hermes gateway regardless of what it could answer.
  const commandList = filterExecutableCommands(
    mode === 'rpc' ? homeQuickCommands() : mode === 'agent' ? agentCommands() : [],
    capabilitySnapshot.methods,
  );

  if (!activeGateway) {
    return (
      <Screen>
        <ChatEmptyState
          title="Tools"
          description="Connect to your PC first — terminal and commands unlock automatically."
          onConnect={() => void retryAutoConnect()}
          onGoHome={() => router.replace('/')}
        />
      </Screen>
    );
  }

  const modeLabel = mode === 'shell' ? 'Shell' : mode === 'rpc' ? 'Gateway RPC' : 'Agent';

  return (
    <Screen edges={['bottom']} parallaxY={parallaxY}>
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text variant="caption" color="accentWarm" style={styles.headerKicker}>
            {settings.pcName ?? activeGateway.name}
          </Text>
          <Text color="secondary" variant="caption">
            {modeLabel} · {mode === 'shell' ? (terminalConnected ? 'live' : 'starting…') : status}
          </Text>
        </View>
        <ConnectionBadge status={status} detail={statusDetail} />
      </View>

      <View style={styles.modePicker}>
        <TerminalModePicker mode={mode} onModeChange={setMode} />
      </View>

      {terminalError && shellSupported ? (
        <View style={styles.bannerWrap}>
          <ErrorCard
            cause={terminalError}
            affected={`${modeLabel.toLowerCase()} session`}
            next="Retry the session or ensure the gateway is connected."
            retryLabel="Retry terminal"
            onRetry={() => void startTerminal()}
          />
        </View>
      ) : null}

      {mode === 'shell' && !shellSupported ? (
        <View style={styles.commandContent}>
          <EmptyState
            icon={{ ios: 'terminal', android: 'terminal', web: 'terminal' }}
            title="No shell on this gateway"
            description={`${activeGateway.name} does not offer a terminal endpoint. Use RPC or Agent commands, or open a shell on the gateway host.`}
          />
        </View>
      ) : mode === 'shell' ? (
        <>
          <View
            style={[
              styles.terminalPane,
              {
                backgroundColor: tokens.backgroundInset,
                borderColor: tokens.glassBorder,
              },
            ]}>
            <View style={[styles.terminalBanner, { borderBottomColor: tokens.glassBorder }]}>
              <View
                style={[
                  styles.terminalBannerDot,
                  { backgroundColor: terminalConnected ? tokens.statusConnected : tokens.statusConnecting },
                ]}
              />
              <Text variant="caption" color={terminalConnected ? 'statusConnected' : 'secondary'}>
                {terminalConnected
                  ? 'connected'
                  : terminalError
                    ? 'session error'
                    : 'starting…'}
                {terminalConnected && activeHello?.server?.version ? ` · v${activeHello.server.version}` : ''}
              </Text>
            </View>
            <TerminalOutput lines={terminalLines} onScroll={onScroll} />
          </View>

          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            {inputHistory.length > 0 ? (
              <View style={styles.historyRow}>
                {inputHistory.slice(0, 3).map((command) => (
                  <Chip
                    key={command}
                    label={command}
                    onPress={() => setInput(command)}
                    style={styles.historyChip}
                  />
                ))}
              </View>
            ) : null}
            <Card
              padding={Spacing.two}
              style={[styles.inputCard, { borderColor: tokens.accentWarmMuted }]}
            >
              <TextInput
                style={[styles.input, { color: tokens.textPrimary }]}
                value={input}
                onChangeText={setInput}
                onKeyPress={handleInputKeyPress}
                placeholder="Shell input (Enter sends)"
                placeholderTextColor={tokens.textTertiary}
                onSubmitEditing={() => void sendToTerminal()}
                returnKeyType="send"
                accessibilityLabel="Terminal input"
              />
              <Button label="Send" size="sm" onPress={() => void sendToTerminal()} />
            </Card>
          </KeyboardAvoidingView>
        </>
      ) : (
        <ScrollView
          style={styles.commandContent}
          contentContainerStyle={styles.commandScroll}
          onScroll={onScroll}
          scrollEventThrottle={16}>
          <GatewayCommandPanel
            title={mode === 'rpc' ? 'Gateway RPC' : 'Agent commands'}
            commands={commandList}
            runningCommandId={runningCommandId}
            lastSummary={commandOutput || undefined}
            onRun={(command) => void runGatewayCommand(command)}
            onOpenOutput={() => setLogSheetVisible(true)}
          />
          {commandLog ? (
            <Card padding={Spacing.two} style={[styles.resultCard, { borderColor: tokens.glassBorder }]}>
              {commandOutput && commandOutput !== commandLog ? (
                <Text variant="caption" color="secondary" style={styles.resultSummary}>
                  {commandOutput}
                </Text>
              ) : null}
              <CommandResultView log={commandLog} />
            </Card>
          ) : (
            <Text color="tertiary" variant="caption">
              {status === 'connected'
                ? 'Run a command to inspect or control the live gateway.'
                : 'Connect to the gateway to run commands.'}
            </Text>
          )}
        </ScrollView>
      )}

      <CommandLogSheet visible={logSheetVisible} log={commandLog} onClose={() => setLogSheetVisible(false)} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.two,
    paddingBottom: Spacing.one,
    gap: Spacing.two,
  },
  headerText: {
    flex: 1,
    gap: Spacing.half,
  },
  headerKicker: {
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  modePicker: {
    paddingHorizontal: Spacing.four,
    paddingBottom: Spacing.two,
  },
  bannerWrap: {
    marginHorizontal: Spacing.four,
    marginBottom: Spacing.two,
  },
  terminalPane: {
    flex: 1,
    marginHorizontal: Spacing.four,
    minHeight: 180,
    borderRadius: Radius.lg,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
  },
  terminalBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
    borderBottomWidth: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(0,0,0,0.18)',
  },
  terminalBannerDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  historyRow: {
    flexDirection: 'row',
    gap: Spacing.two,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.one,
  },
  historyChip: {
    maxWidth: 160,
  },
  inputCard: {
    marginHorizontal: Spacing.four,
    marginBottom: Spacing.two,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: Spacing.two,
    borderRadius: Radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 140,
    fontSize: 14,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
  },
  commandContent: {
    flex: 1,
    paddingHorizontal: Spacing.four,
    paddingBottom: Spacing.four,
  },
  commandScroll: {
    gap: Spacing.three,
    paddingBottom: Spacing.four,
  },
  resultCard: {
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: Spacing.two,
  },
  resultSummary: {
    marginBottom: Spacing.one,
  },
});
