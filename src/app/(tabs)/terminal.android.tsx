/**
 * Pass 2 plan:
 * 1. Inset terminal pane with token borders
 * 2. M3 SegmentedButton mode picker + AssistChip commands
 * 3. Haptics on send, retry, command execution
 * 4. CommandLogSheet with luxury M3 bottom sheet
 * 5. Structured error banner (Cause / Affected / Next)
 */
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import { ChatEmptyState } from '@/components/chat/chat-empty-state';
import { ConnectionBadge } from '@/components/connection-badge';
import { GatewayCommandPanel } from '@/components/gateway/gateway-command-panel';
import { CommandLogSheet } from '@/components/terminal/command-log-sheet';
import { TerminalModePicker, type TerminalMode } from '@/components/terminal/mode-picker';
import { Button, Card, Screen, Text, TextField } from '@/components/ui';
import { FontFamily, Motion, Radius, Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import { useTokens } from '@/hooks/use-tokens';
import {
  agentCommands,
  homeQuickCommands,
  summarizeCommandResult,
  type GatewayCommand,
} from '@/lib/gateway/dashboard';
import { entering } from '@/lib/motion/presets';
import {
  openTerminalSession,
  sendTerminalInput,
  type TerminalSession,
} from '@/lib/terminal/client';

export default function TerminalScreen() {
  const router = useRouter();
  const tokens = useTokens();
  const {
    activeGateway,
    status,
    statusDetail,
    settings,
    retryAutoConnect,
    gatewayRequest,
    runAgentCommand,
  } = useGateway();
  const [mode, setMode] = useState<TerminalMode>('shell');
  const [output, setOutput] = useState('');
  const [input, setInput] = useState('');
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const [terminalConnected, setTerminalConnected] = useState(false);
  const [runningCommandId, setRunningCommandId] = useState<string | null>(null);
  const [commandLog, setCommandLog] = useState('');
  const [logSheetVisible, setLogSheetVisible] = useState(false);
  const sessionRef = useRef<TerminalSession | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  const appendOutput = useCallback((chunk: string) => {
    setOutput((prev) => prev + chunk);
    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
  }, []);

  const startTerminal = useCallback(async () => {
    if (!activeGateway || status !== 'connected' || mode !== 'shell') return;
    sessionRef.current?.close();
    setOutput('');
    setTerminalError(null);
    setTerminalConnected(false);

    try {
      const session = await openTerminalSession(activeGateway.url, {
        onOutput: appendOutput,
        onError: (message) => {
          setTerminalError(message);
          setTerminalConnected(false);
        },
        onExit: (code) => {
          appendOutput(`\n[exit ${code}]\n`);
          setTerminalConnected(false);
        },
      }, activeGateway.token);
      sessionRef.current = session;
      setTerminalConnected(true);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTerminalError(message);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  }, [activeGateway, appendOutput, mode, status]);

  useEffect(() => {
    if (mode === 'shell' && activeGateway && status === 'connected') {
      void startTerminal();
      return () => sessionRef.current?.close();
    }
    sessionRef.current?.close();
    setTerminalConnected(false);
    return undefined;
  }, [activeGateway?.id, mode, startTerminal, status]);

  const sendToTerminal = useCallback(async () => {
    const session = sessionRef.current;
    const gateway = activeGateway;
    if (!session || !gateway || !input) return;
    const payload = input.endsWith('\n') ? input : `${input}\n`;
    setInput('');
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await sendTerminalInput(gateway.url, session.sid, payload, gateway.token);
  }, [activeGateway, input]);

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
          setOutput(summary);
          setCommandLog(summary);
        } else {
          if (!command.method) throw new Error('Command has no RPC method');
          const result = await gatewayRequest(command.method, command.params ?? {});
          const summary = summarizeCommandResult(command, result);
          setOutput(summary);
          setCommandLog(JSON.stringify(result, null, 2));
        }
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setTerminalError(message);
        setOutput(`Command failed: ${message}`);
        setCommandLog(message);
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      } finally {
        setRunningCommandId(null);
      }
    },
    [gatewayRequest, runAgentCommand, status],
  );

  const commandList = mode === 'rpc' ? homeQuickCommands() : mode === 'agent' ? agentCommands() : [];

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
    <Screen edges={['bottom']} ambient={false}>
      <Animated.View entering={FadeIn.duration(Motion.duration.fast)} style={styles.header}>
        <View style={styles.headerText}>
          <Text variant="caption" color="accentWarm" style={styles.headerKicker}>
            {settings.pcName ?? activeGateway.name}
          </Text>
          <Text color="secondary" variant="caption">
            {modeLabel} · {mode === 'shell' ? (terminalConnected ? 'live' : 'starting…') : status}
          </Text>
        </View>
        <ConnectionBadge status={status} detail={statusDetail} />
      </Animated.View>

      <View style={styles.modePicker}>
        <TerminalModePicker mode={mode} onModeChange={setMode} />
      </View>

      {terminalError ? (
        <Animated.View entering={entering.fadeIn}>
          <Card
            variant="inset"
            padding={Spacing.two}
            style={[styles.banner, { borderColor: tokens.statusDisconnected }]}>
            <Text color="secondary" variant="caption">
              Cause: {terminalError}. Affected: {modeLabel.toLowerCase()} session. Next: Retry terminal or ensure
              gateway is connected.
            </Text>
            {mode === 'shell' ? (
              <Button
                label="Retry terminal"
                variant="ghost"
                onPress={async () => {
                  await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  void startTerminal();
                }}
              />
            ) : null}
          </Card>
        </Animated.View>
      ) : null}

      {mode === 'shell' ? (
        <>
          <View
            style={[
              styles.terminalPane,
              {
                backgroundColor: tokens.backgroundInset,
                borderColor: tokens.glassBorder,
              },
            ]}>
            <ScrollView ref={scrollRef} contentContainerStyle={styles.terminalScroll}>
              <Text variant="mono" style={[styles.terminalText, { color: tokens.textPrimary }]}>
                {output || 'Terminal output will appear here…'}
              </Text>
            </ScrollView>
          </View>

          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <Card
              padding={Spacing.two}
              style={[styles.inputCard, { borderColor: tokens.accentWarmMuted }]}>
              <TextField
                value={input}
                onChangeText={setInput}
                placeholder="Shell input (Enter sends)"
                style={styles.input}
              />
              <Button label="Send" onPress={() => void sendToTerminal()} />
            </Card>
          </KeyboardAvoidingView>
        </>
      ) : (
        <ScrollView contentContainerStyle={styles.commandContent}>
          <GatewayCommandPanel
            title={mode === 'rpc' ? 'Gateway RPC' : 'Agent commands'}
            commands={commandList}
            runningCommandId={runningCommandId}
            lastSummary={output || undefined}
            onRun={(command) => void runGatewayCommand(command)}
            onOpenOutput={() => setLogSheetVisible(true)}
          />
          {output ? (
            <Card padding={Spacing.two} style={[styles.resultCard, { borderColor: tokens.glassBorder }]}>
              <Text variant="mono" color="secondary">
                {output}
              </Text>
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

      <CommandLogSheet
        visible={logSheetVisible}
        log={commandLog}
        onClose={() => setLogSheetVisible(false)}
      />
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
  banner: {
    marginHorizontal: Spacing.four,
    gap: Spacing.two,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  terminalPane: {
    flex: 1,
    marginHorizontal: Spacing.four,
    minHeight: 180,
    borderRadius: Radius.lg,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
  },
  terminalScroll: {
    padding: Spacing.two,
  },
  terminalText: {
    fontFamily: FontFamily.mono,
    fontSize: 12,
    lineHeight: 18,
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
  },
  commandContent: {
    paddingHorizontal: Spacing.four,
    paddingBottom: Spacing.four,
    gap: Spacing.three,
  },
  resultCard: {
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
});