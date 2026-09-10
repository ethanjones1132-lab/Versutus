import * as Clipboard from 'expo-clipboard';
import { type Href, useFocusEffect, useIsFocused, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, FlatList, Platform, RefreshControl, StyleSheet, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated from 'react-native-reanimated';

import { ApprovalSheet } from '@/components/chat/approval-sheet';
import { BotChrome } from '@/components/chat/bot-chrome';
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
import { Button, Card, EmptyState, ErrorCard, Icon, PressableScale, Screen, Skeleton, Text, type IconName, type TextFieldHandle } from '@/components/ui';
import { Motion, Radius, Spacing } from '@/constants/tokens';
import { entering } from '@/lib/motion/presets';
import { useChatSurface, useGateway } from '@/context/gateway-provider';
import { describeGatewayError, errorBannerButton, humanizeGatewayError } from '@/lib/gateway/error-humanizer';
import { useTokens } from '@/hooks/use-tokens';
import { getSlashCommandSuggestions } from '@/lib/gateway/slash-commands';
import { formatDayDividerCached } from '@/lib/format';
import { haptics } from '@/lib/haptics';
// The phone-side local notice a routine's schedule maps to; every confirmed
// mutation below keeps it in step (fire-and-forget, best-effort).
import {
  cancelRoutineNotification,
  rearmRoutineNotifications,
  syncRoutineNotification,
} from '@/lib/notifications/routine-sync';
import { resolvePullRefreshAction } from '@/lib/gateway/messages';
import { openSessionById } from '@/lib/gateway/session-open-by-id';
import type { ChatMessage, HermesSession } from '@/lib/gateway/types';
import { botChromeCombined } from '@/lib/gateway/bot-chrome';
import { composerFocusApplies } from '@/lib/gateway/composer-focus';
import { applyRosterRead } from '@/lib/gateway/roster-read';
import {
  applyBotSoulRead,
  botSoulReadFromUnknown,
  botToEditInput,
  buildBotUpdatePatch,
  buildRoster,
  EMPTY_BOT_SOUL,
  type BotSoulState,
  type ChatSurface,
  type PublicBot,
  type RosterRow,
} from '@/lib/gateway/bots';
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
  routineJobsFromList,
  routineName,
  type RoutineRead,
  type RoutinesState,
} from '@/lib/gateway/routines';
import {
  applySessionSpendRead,
  EMPTY_SESSION_SPEND,
  overflowSpendCopy,
  overflowSpendSession,
  SESSION_SPEND_LIST_LIMIT,
  sessionSpendReadFromUnknown,
  threadSpendCopy,
  threadSpendRefreshKey,
  type SessionSpendState,
} from '@/lib/gateway/session-analytics';
import {
  applySkillsRead,
  EMPTY_SKILLS,
  skillInvokePrefillsComposer,
  skillsReadFromUnknown,
  skillSlashText,
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
  spokenDraftText,
} from '@/lib/gateway/composer-draft';
import { composeRequestApplies } from '@/lib/gateway/compose-request';
import { effectiveModel } from '@/lib/gateway/model-selection';
import { insertMention, mentionPicksAtCaret } from '@/lib/gateway/mentions';
import {
  loadSessionLabels,
  sessionLabelKey,
  sessionLabelTitle,
  type SessionLabel,
} from '@/lib/gateway/session-labels';
import {
  overflowNewSessionHop,
  resolveThreadConfigMode,
  threadConfigOfferedModes,
  type ThreadConfigMode,
} from '@/lib/gateway/thread-config';
import {
  botVoiceOptions,
  botVoiceRefinementPatch,
  botVoiceRefinementRows,
  type BotVoiceRefinementField,
} from '@/lib/voice/bot-voices';
import { speakerAction } from '@/lib/voice/speech-reply';
import { availableVoices, speakReply, speechAvailableFrom, stopSpeech } from '@/lib/voice/speech';
import {
  acknowledgeSilentModeHint,
  applyBotVoice,
  applySpeakerOn,
  botVoicePreferenceKey,
  clearVoicePreference,
  loadVoicePreferences,
  readBotVoice,
  readSpeakerOn,
  saveVoicePreferences,
  shouldShowSilentModeHint,
  SILENT_MODE_HINT_COPY,
  speakerPreferenceKey,
  type BotVoice,
} from '@/lib/voice/voice-preferences';
import { useAmbientParallaxScroll } from '@/lib/motion/ambient-parallax';
import { screenEdgesFor } from '@/lib/motion/screen-edges';
import { chatTranscriptContentPaddingBottom } from '@/lib/motion/chat-transcript-insets';
import { chatJumpBottom } from '@/lib/motion/chat-jump-inset';

const PIN_THRESHOLD_PX = 96;
const JUMP_PILL_THRESHOLD_PX = 260;
// Any offset within this of the true top counts as "at top" so the pull
// gesture pages back instead of reloading the same window (bounce rounding
// and the header button keep tiny offsets live).
const AT_TOP_PX = 8;

type SessionRecord = HermesSession & { sessionId?: string; name?: string };

// One transcript row: the message plus the day-divider decision, computed once
// per message-array change so renderItem stays referentially stable mid-turn.
type TranscriptItem = { message: ChatMessage; label: string | undefined; showDivider: boolean };

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

/**
 * How long a banner the operator cannot act on stays up before clearing
 * itself. Only the `dismiss` kind auto-clears: a setup or reconnect banner
 * carries the control that fixes the fault, and timing that out would take
 * the fix away mid-read.
 */
const DISMISSIBLE_ERROR_TIMEOUT_MS = 12000;

function LastErrorBanner({
  error,
  onSetup,
  onReconnect,
  onDismiss,
}: {
  error: unknown;
  onSetup: () => void;
  onReconnect: () => void;
  onDismiss: () => void;
}) {
  const humanized = humanizeGatewayError(error);
  const button = errorBannerButton(humanized.action);
  let onRetry: (() => void) | undefined;
  switch (button.kind) {
    case 'setup':
      onRetry = onSetup;
      break;
    case 'reconnect':
      onRetry = onReconnect;
      break;
    case 'copy':
      onRetry = () => {
        void Clipboard.setStringAsync(describeGatewayError(error)).then(() => haptics.success());
      };
      break;
    case 'dismiss':
      // No action button: the kind IS "nothing to do but close it". It used to
      // render no control at all, so the card could never be got rid of.
      onRetry = undefined;
      break;
  }

  const selfClearing = button.kind === 'dismiss';
  useEffect(() => {
    if (!selfClearing) return undefined;
    const timer = setTimeout(onDismiss, DISMISSIBLE_ERROR_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [selfClearing, onDismiss]);

  return (
    <Animated.View entering={entering.fadeIn.duration(Motion.duration.fast)} style={styles.bannerWrap}>
      <ErrorCard
        cause={humanized.cause}
        affected={humanized.affected}
        next={humanized.next}
        retryLabel={button.kind === 'dismiss' ? undefined : button.label}
        onRetry={onRetry}
        collapsible
        onDismiss={onDismiss}
      />
    </Animated.View>
  );
}

function PairingRequiredBanner({ onShow }: { onShow: () => void }) {
  return (
    <View style={styles.bannerWrap}>
      <Card padding={Spacing.three} style={styles.pairingBanner}>
        <Text variant="headline">Pairing required</Text>
        <Text variant="caption" color="secondary">
          Approve this phone on your PC to finish connecting.
        </Text>
        <Button label="Show pairing code" variant="secondary" size="sm" onPress={onShow} />
      </Card>
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
    lastError,
    clearLastError,
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
    modelCatalogError,
    sessionSelector,
    openSessionSelector,
    closeSessionSelector,
    selectSession,
    sessionList,
    sessionListError,
    sessionListLoaded,
    sessionListHasOlder,
    loadingOlderSessions,
    loadOlderSessions,
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
    requestedSurface,
    clearRequestedSurface,
    requestedComposerFocus,
    clearRequestedComposerFocus,
    requestedComposeRequest,
    clearRequestedComposeRequest,
  } = useGateway();

  // The transcript and its send state come from the chat-surface context so
  // a streamed frame re-renders this screen alone, not every mounted tab.
  const { messages, isSending, isCommandRunning } = useChatSurface();

  // Keyed by gateway + surface + session so leaving a thread and coming
  // back restores that thread's unsent text, never another Bot's.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [dismissedPairingKey, setDismissedPairingKey] = useState<string | null>(null);
  const [overflowVisible, setOverflowVisible] = useState(false);
  const [backendPickerVisible, setBackendPickerVisible] = useState(false);
  const [paletteVisible, setPaletteVisible] = useState(false);
  const openPalette = useCallback(() => setPaletteVisible(true), [setPaletteVisible]);
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
  // The soul is read only when a Bot is actually opened - it is off the roster
  // payload on purpose (a soul can be long, the roster is re-read constantly).
  const [soulState, setSoulState] = useState<BotSoulState & { botId: string | null }>({
    botId: null,
    ...EMPTY_BOT_SOUL,
  });

  useEffect(() => {
    const openId = detailBot?.id ?? null;
    if (!openId || status !== 'connected') return;
    let cancelled = false;
    const fold = (read: Parameters<typeof applyBotSoulRead>[1]) => {
      if (cancelled) return;
      setSoulState((prev) => {
        const previous = prev.botId === openId ? prev : { botId: openId, ...EMPTY_BOT_SOUL };
        return { botId: openId, ...applyBotSoulRead(previous, read) };
      });
    };
    void gatewayRequest('bots.get', { id: openId })
      .then((payload) => fold(botSoulReadFromUnknown(payload)))
      .catch(() => fold({ ok: false }));
    return () => {
      cancelled = true;
    };
  }, [detailBot, status, gatewayRequest]);
  const handleSoulRetry = useCallback(() => {
    const openId = detailBot?.id ?? null;
    if (!openId || status !== 'connected') return;
    const target = openId;
    const fold = (read: Parameters<typeof applyBotSoulRead>[1]) => {
      setSoulState((prev) => {
        const previous = prev.botId === target ? prev : { botId: target, ...EMPTY_BOT_SOUL };
        return { botId: target, ...applyBotSoulRead(previous, read) };
      });
    };
    void gatewayRequest('bots.get', { id: target })
      .then((payload) => fold(botSoulReadFromUnknown(payload)))
      .catch(() => fold({ ok: false }));
  }, [detailBot, status, gatewayRequest]);
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
  // A manual re-read has no gesture to ride on — the spend refresh key is
  // fully derived — so Retry bumps this tick, which is folded into the key
  // below and re-runs the spend effect with the same read.
  const [spendRetryTick, setSpendRetryTick] = useState(0);
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
  // The name the header prints for this thread is the operator's own when they
  // gave one — the same rule the selector row prints (the store's fold, so the
  // `Untitled` fallback stays one rule in the repo). The blob is re-read when
  // the thread-config sheet closes, because the sheet is where a rename is
  // typed: without that the header would keep the name it mounted with. The
  // read is this device's own store — the header asks the gateway nothing.
  const [sessionLabels, setSessionLabels] = useState<Record<string, SessionLabel>>({});
  useEffect(() => {
    if (sessionSelector.visible) return;
    let cancelled = false;
    void loadSessionLabels().then((stored) => {
      if (!cancelled) setSessionLabels(stored);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionSelector.visible]);
  // The active Bot, named once for every Bot-keyed surface below (its skills,
  // its tools, and the voice its replies are read in).
  const botSurfaceId = surface.kind === 'bot' ? surface.botId : undefined;
  // The speaker is one conversation's own opt-in (B2), held in this device's
  // store beside a Bot's voice, so the flag is read and written here and the
  // gateway is asked nothing. Whether this device has a voice to read a reply
  // in is the platform's own answer, and the header offers the control only
  // where a tap can finish. That answer is the same read the picker's rows come
  // from (below), so one return paints both and the two surfaces cannot
  // disagree about what this device has.
  const speakerKey = draftThread ? speakerPreferenceKey(draftThread) : undefined;
  const [speakerOn, setSpeakerOn] = useState(false);
  const [speechReady, setSpeechReady] = useState(false);
  // The one-time silent-mode hint B2 asks for (`FUTURE-ITEMS.md:441-442`):
  // whether this device is still owed it, and whether the line is drawn. Both
  // come off the store's own rule, which is handed the platform — the screen
  // authors no platform test of its own, so a device that is not iOS is never
  // owed a hint at all.
  const [silentHintOwed, setSilentHintOwed] = useState(false);
  const [silentHintShown, setSilentHintShown] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void loadVoicePreferences().then((stored) => {
      if (cancelled) return;
      setSpeakerOn(speakerKey ? readSpeakerOn(stored, speakerKey) : false);
      setSilentHintOwed(shouldShowSilentModeHint(stored, Platform.OS));
      // The line belongs to the edge that drew it: a conversation the screen
      // opens or returns to starts without one.
      setSilentHintShown(false);
    });
    return () => {
      cancelled = true;
    };
  }, [speakerKey]);
  const handleSpeakerPress = useCallback(() => {
    const key = speakerKey;
    if (!key) return;
    const next = !speakerOn;
    // A toggle-off is one of the two ways a reply is silenced (B2), and it
    // silences it while the flag it belongs to is still on. The one-time hint
    // goes with the speaker it came with: it is a hint, not an error.
    if (!next) {
      void stopSpeech();
      setSilentHintShown(false);
    }
    setSpeakerOn(next);
    // The hint is drawn on the edge the speaker comes on, and the
    // acknowledgement rides the SAME write as the flag — so it is cleared as
    // it is shown, and this device is never told twice.
    const showHint = next && silentHintOwed;
    if (showHint) {
      setSilentHintShown(true);
      setSilentHintOwed(false);
    }
    // The blob is read back and folded before it is written, so this one
    // conversation's flag moves without dropping a Bot's voice beside it.
    void loadVoicePreferences().then((stored) => {
      const written = applySpeakerOn(stored, key, next);
      return saveVoicePreferences(showHint ? acknowledgeSilentModeHint(written) : written);
    });
  }, [speakerKey, speakerOn, silentHintOwed]);

  // A Bot's own voice (B2) is the same device store's, keyed by the gateway and
  // the Bot so one name on two gateways is two voices. The rows are this
  // device's own list through the pure fold, the choice is read with the
  // store's own read, and the reply is read in it — the screen authors neither
  // the key, the order nor the rule. The WHOLE entry is kept rather than its
  // identifier alone, because the rate and pitch beside it are how that voice
  // speaks: they are what the refinement rows mark and what a reply is read
  // with, and neither is the screen's to know.
  const botVoiceKey =
    activeGateway && botSurfaceId ? botVoicePreferenceKey(activeGateway.id, botSurfaceId) : undefined;
  const [botVoice, setBotVoice] = useState<BotVoice | undefined>(undefined);
  const botVoiceId = botVoice?.voiceIdentifier;
  const [deviceVoices, setDeviceVoices] = useState<unknown[]>([]);
  // The list is this device's, and a voice is installed in the phone's own
  // settings while this app is alive — so it is read again on every return to
  // this surface rather than once at a mount a tab screen never repeats. Both
  // routes back in are needed: a download is made by LEAVING the app, which
  // backgrounds this screen rather than blurring its route, so the foreground
  // edge is what catches that trip and the tab's own focus is what asks the
  // device again once the operator is back. The header's own availability
  // answer is this same read asked as the seam's rule, so a device that gains a
  // voice gains its toggle here too, rather than a Voice section whose pick
  // nothing could turn on. What the rows are drawn from is unchanged — the fold
  // still decides what a usable row is, and a device the platform names no
  // voice for is still handed nothing to draw.
  const refreshDeviceVoices = useCallback(() => {
    let live = true;
    void availableVoices().then((voices) => {
      if (!live) return;
      setDeviceVoices(voices);
      setSpeechReady(speechAvailableFrom(voices));
    });
    return () => {
      live = false;
    };
  }, []);
  useFocusEffect(refreshDeviceVoices);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') refreshDeviceVoices();
    });
    return () => subscription.remove();
  }, [refreshDeviceVoices]);
  useEffect(() => {
    let cancelled = false;
    void loadVoicePreferences().then((stored) => {
      if (!cancelled) setBotVoice(botVoiceKey ? readBotVoice(stored, botVoiceKey) : undefined);
    });
    return () => {
      cancelled = true;
    };
  }, [botVoiceKey]);
  const botVoiceChoices = useMemo(
    () => botVoiceOptions(deviceVoices, botVoiceId),
    [deviceVoices, botVoiceId],
  );
  // The rate and pitch rows under those chips: the fold's own ladder, marked
  // with the step this Bot stands at. A Bot stored with no voice is answered no
  // rows at all, so the control appears exactly where it has somewhere to
  // write — and every step it offers is the module's.
  const botVoiceRefinements = useMemo(() => botVoiceRefinementRows(botVoice), [botVoice]);
  const handleBotVoiceSelect = useCallback(
    (identifier: string | undefined) => {
      const key = botVoiceKey;
      if (!key) return;
      // The chip lights before the blob is read, and the entry's own
      // refinements ride along: the store merges the patch onto what it holds,
      // so a voice change leaves this Bot's rate and pitch standing.
      setBotVoice((current) => (identifier ? { ...current, voiceIdentifier: identifier } : undefined));
      // The blob is read back and folded before it is written, so one Bot's
      // voice moves without dropping this conversation's speaker flag.
      void loadVoicePreferences().then((stored) =>
        saveVoicePreferences(
          identifier
            ? applyBotVoice(stored, key, { voiceIdentifier: identifier })
            : clearVoicePreference(stored, key),
        ),
      );
    },
    [botVoiceKey],
  );
  const handleBotVoiceRefine = useCallback(
    (field: BotVoiceRefinementField, value: number) => {
      const key = botVoiceKey;
      if (!key) return;
      // A step this ladder does not hold is refused rather than rounded to a
      // neighbour, so nothing is written and nothing is shown to have moved.
      const patch = botVoiceRefinementPatch(field, value);
      if (!patch) return;
      // The blob is read back and folded before it is written, so one Bot's
      // rate moves without dropping its voice, its pitch or this
      // conversation's speaker flag — and what the control shows is the store's
      // own read of what was actually written, not the step that was tapped.
      void loadVoicePreferences().then((stored) => {
        const written = applyBotVoice(stored, key, patch);
        setBotVoice(readBotVoice(written, key));
        return saveVoicePreferences(written);
      });
    },
    [botVoiceKey],
  );

  // The transcript's own tail decides what the speaker owes — the rule is
  // `speakerAction`'s, in `src/lib/voice/speech-reply.ts` — so a finished
  // reply is read, a new turn silences the queue, and everything still
  // arriving is left alone. What has been read is remembered by message id,
  // per conversation and per flag: a re-render cannot read one reply twice,
  // and a thread just opened or a speaker just turned on is not read back at
  // the operator — only what arrives from there is new.
  const transcriptTail = messages.length ? messages[messages.length - 1] : undefined;
  const speakerMemoryRef = useRef<{ thread?: string; flag: boolean; id?: string }>({
    flag: false,
  });
  useEffect(() => {
    const memory = speakerMemoryRef.current;
    if (memory.thread !== speakerKey || memory.flag !== speakerOn) {
      speakerMemoryRef.current = { thread: speakerKey, flag: speakerOn, id: transcriptTail?.id };
      return;
    }
    if (!speakerOn) return;
    const action = speakerAction(transcriptTail);
    if (action.kind === 'silence') {
      void stopSpeech();
      return;
    }
    if (action.kind !== 'speak') return;
    if (memory.id === transcriptTail?.id) return;
    speakerMemoryRef.current = { thread: speakerKey, flag: speakerOn, id: transcriptTail?.id };
    // The Bot's own voice, where this device stored one — the rate and pitch it
    // speaks at ride the same entry — and a Bot with none is read with the
    // platform's own defaults, which is exactly what an empty `ReplyVoice`
    // leaves standing.
    void speakReply(action.text, botVoice ?? {});
  }, [transcriptTail, speakerKey, speakerOn, botVoice]);
  const { parallaxY, onScroll } = useAmbientParallaxScroll();
  const insets = useSafeAreaInsets();
  const listRef = useRef<FlatList<TranscriptItem>>(null);
  // The composer's input, so a Bot Chat link can put the cursor in the composer
  // it opens (item 8). The screen holds the handle because the screen decides
  // whether the request applies at all; the composer just hands its field over.
  const composerInputRef = useRef<TextFieldHandle>(null);
  const pinnedRef = useRef(true);
  const atTopRef = useRef(true);
  const jumpVisibleRef = useRef(false);
  // Latest-commit mirror of `messages` so callbacks that need the list stay
  // referentially stable while a turn streams (see handleResumeMessage).
  const messagesRef = useRef<ChatMessage[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Every surface change funnels through here so the screen-local backends
  // section cannot outlive the configurable thread it belongs to (rook
  // 2026-08-24): navigating to a bot room, group room or the roster closes
  // it together with everything else that thread owned. Provider-owned
  // session/model flags are untouched — they stay valid on every surface.
  const showSurface = useCallback((next: ChatSurface) => {
    setBackendPickerVisible(false);
    setSurface(next);
  }, []);

  // A request to move the surface, from outside this screen — the quick-reply
  // path opens a Bot Chat in the provider, which reloads the transcript this
  // screen renders but cannot reach `showSurface`. Without this the header and
  // the backends picker would keep naming the thread the operator left, over a
  // transcript that is now the Bot Chat's. Applied once and cleared, so it can
  // never fight the operator's own next navigation.
  useEffect(() => {
    if (!requestedSurface) return undefined;
    // Deferred a tick like every other producer in this repo: writing state
    // straight from an effect body trips react-hooks/set-state-in-effect.
    const timer = setTimeout(() => {
      showSurface(requestedSurface);
      clearRequestedSurface();
    }, 0);
    return () => clearTimeout(timer);
  }, [requestedSurface, showSurface, clearRequestedSurface]);

  // A Bot Chat link opens a thread and asks for the cursor in the composer it
  // opens (item 8). The request rides on the provider because the open is a
  // gateway read; it is applied only where it can be honoured — this screen,
  // while it is the tab in front of the operator, showing the Bot Chat the
  // request names — so it can never open the keyboard over a screen the
  // operator has left. A request that names another thread is held rather than
  // dropped: the promise was that Bot Chat. Cleared as it is applied, because a
  // focus is a one-shot and not a surface.
  const isFocused = useIsFocused();
  useEffect(() => {
    if (!requestedComposerFocus || !isFocused) return undefined;
    if (!composerFocusApplies(requestedComposerFocus, surface)) return undefined;
    // Deferred a tick like every other producer in this repo — and the field
    // has to be mounted before it can take the cursor.
    const timer = setTimeout(() => {
      composerInputRef.current?.focus();
      clearRequestedComposerFocus();
    }, 0);
    return () => clearTimeout(timer);
  }, [requestedComposerFocus, isFocused, surface, clearRequestedComposerFocus]);

  // A shared text that arrived from outside the app — item 5's
  // `versutus://compose` link, and a native share later — waits on the provider
  // until the thread it is for is the one in front of the operator. It is
  // written through the composer's one writer and composed with the rule the
  // spoken draft states, so words already typed are never dropped and the
  // shared text is never re-worded: shared content is untrusted input, and what
  // lands is a draft the operator reviews — nothing on this path sends. Applied
  // once and cleared, because a request is a one-shot like a focus and must not
  // fight the operator's own next edit. A request naming another thread, or one
  // that arrives before a thread is up, is HELD rather than dropped: the
  // promise was that thread's draft. Writing the key is what makes the hold
  // safe against the load above — the async read fills a thread's draft only
  // where nothing has written it yet.
  useEffect(() => {
    if (!requestedComposeRequest || !isFocused || !draftThread) return undefined;
    if (!composeRequestApplies(requestedComposeRequest, surface)) return undefined;
    // The thread's own stored draft has to have been read first. On a cold
    // start the load above and this effect are in flight together, and that
    // load keeps whatever a thread already holds (`if (prev[key] !== undefined)
    // return prev;`): a shared text written before the read lands is the value
    // that stays, and the words the operator had left in that thread never
    // arrive. A reading is recorded even when it is empty, so the key's
    // presence is the answer.
    if (drafts[composerDraftKey(draftThread)] === undefined) return undefined;
    // Deferred a tick like every other producer in this repo — and the field
    // has to be mounted before it can take the cursor.
    const timer = setTimeout(() => {
      setDraft(spokenDraftText(draft, requestedComposeRequest.text));
      composerInputRef.current?.focus();
      clearRequestedComposeRequest();
    }, 0);
    return () => clearTimeout(timer);
  }, [
    requestedComposeRequest,
    isFocused,
    draftThread,
    drafts,
    draft,
    surface,
    setDraft,
    clearRequestedComposeRequest,
  ]);

  // Stable header callbacks. The chat header is memoized (chat-header.tsx) so it
  // skips a re-render when only the transcript changes; inline arrow wrappers here
  // would hand it a fresh function identity every frame and defeat that memo. These
  // wrappers keep a single reference for the whole surface so the header is skipped
  // during a streaming turn. Each is built from a stable dependency (a callback or a
  // useState setter), so its identity never changes across renders.
  const handleHeaderSessionPress = useCallback(() => {
    void openSessionSelector();
  }, [openSessionSelector]);
  const handleHeaderModelPress = useCallback(() => {
    void openModelPicker('default');
  }, [openModelPicker]);
  const handleHeaderOverflowPress = useCallback(() => {
    setOverflowVisible(true);
  }, []);
  const handleHeaderBackendPress = useCallback(() => {
    setBackendPickerVisible(true);
  }, []);
  const handleHeaderRosterPress = useCallback(() => {
    clearBot();
    showSurface({ kind: 'roster' });
  }, [clearBot, showSurface]);

  const pairingKey = `${deviceId ?? ''}:${pairingDetails?.requestId ?? ''}`;
  const isStreaming = isSending || messages.some((message) => message.streaming);
  const queuedCount = messages.filter((message) => message.queued).length;
  const showPairingSheet = status === 'pairing' && !!deviceId && dismissedPairingKey !== pairingKey;
  // Dismiss hides the sheet without ending pairing — this banner is the way
  // back to the same approve code while status stays pairing.
  const showPairingBanner = status === 'pairing' && !!deviceId && dismissedPairingKey === pairingKey;
  // The registry build walks every command, dynamic entry, and skill, so it
  // runs only when one of its inputs changes — not on every streamed frame
  // that re-renders this screen while the draft holds `/`.
  const slashSuggestions = useMemo(
    () =>
      draft.trimStart().startsWith('/')
        ? getSlashCommandSuggestions(
            draft,
            activeHello,
            recentCommands,
            capabilitySnapshot.methods,
            dynamicCommands,
            12,
            skillsState.skills,
          )
        : [],
    [draft, activeHello, recentCommands, capabilitySnapshot.methods, dynamicCommands, skillsState.skills],
  );
  // Stable across streamed frames (icons + drafts never change) so the memoized
  // ChatComposer short-circuits when only `messages` changed.
  const quickActions: { label: string; draft: string; icon: IconName }[] = useMemo(
    () => [
      { label: 'Run', draft: '/run ', icon: { ios: 'bolt.fill', android: 'bolt', web: 'bolt' } },
      { label: 'Status', draft: '/status', icon: { ios: 'waveform.path.ecg', android: 'pulse', web: 'pulse' } },
      { label: 'Help', draft: '/help', icon: { ios: 'questionmark.circle', android: 'help', web: 'help' } },
    ],
    [],
  );

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
        skillsState.skills,
      ),
    [activeHello, recentCommands, capabilitySnapshot.methods, dynamicCommands, skillsState.skills],
  );

  // The open config sheet's session list re-renders its visible rows whenever
  // this array's identity changes, so it must be stable across the streamed
  // frames that touch everything else on this screen. `sessionList` only
  // changes identity when the gateway actually sends new sessions.
  const sessions = useMemo(() => (sessionList as SessionRecord[]).map(toSessionItem), [sessionList]);
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

  // The model SectionList in the config sheet re-renders its visible rows on
  // every new array identity. The gateway only changes the catalog when models
  // are added, removed, or re-priced, so memoize on `modelCatalog` and let the
  // streamed frames that churn the rest of this screen reuse the same rows.
  const modelRows = useMemo(
    () =>
      modelCatalog.map((model: Record<string, unknown>) => ({
        id: String(model.id || model.model || model.name || ''),
        provider: model.provider as string | undefined,
        providerId: (model.providerId ?? model.provider) as string | undefined,
        modelId: (model.modelId as string | undefined) ?? undefined,
        catalogState: (model.catalogSource ?? model.catalogState) as string | undefined,
        available: model.available !== false,
        context: (model.context ?? model.contextLength) as number | undefined,
        price: (model.cost ?? model.price) as number | undefined,
        auth: (model.authStatus ?? model.auth) as string | undefined,
        usage: model.usage as string | undefined,
      })),
    [modelCatalog],
  );

  // The header's name for the thread, through the store's own fold: the
  // operator's name when the store holds one for this gateway + session, and
  // the shipped gateway-title rule when it does not.
  const sessionLabel = currentSessionId
    ? sessionLabelTitle(
        currentSession?.title,
        activeGateway ? sessionLabels[sessionLabelKey(activeGateway.id, currentSessionId)] : undefined,
      )
    : undefined;
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

  const handleOpenSessionById = useCallback(
    (sessionId: string) => openSessionById(gatewayRequest, sessionId),
    [gatewayRequest],
  );

  const handleSend = useCallback(async () => {
    const text = draft;
    if (!text.trim()) return;
    setDraft('');
    pinnedRef.current = true;
    await sendChatInput(text, { skills: skillsState.skills });
    requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
  }, [draft, sendChatInput, setDraft, skillsState.skills]);

  const handleResumeMessage = useCallback(
    (message: ChatMessage) => {
      const current = messagesRef.current;
      const idx = current.findIndex((m) => m.id === message.id);
      const previousUser = current.slice(0, idx).reverse().find((m) => m.role === 'user');
      if (previousUser?.text.trim()) {
        pinnedRef.current = true;
        void sendChatInput(previousUser.text.trim(), { skills: skillsState.skills });
        requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
      }
    },
    [sendChatInput, skillsState.skills],
  );

  // A skills-pane tap starts the same `/<skill-name>` turn typing it sends:
  // the text goes through `sendChatInput` with the fetched skill list, so the
  // skill passthrough judges it identically. While a turn streams, a command
  // runs, or no gateway is connected, `sendMessage` would silently drop the
  // turn — so the tap prefills the composer with `/<name> ` instead, and a
  // rejected dispatch surfaces through the normal turn-error path.
  const handleSkillInvoke = useCallback(
    (skillName: string) => {
      if (skillInvokePrefillsComposer({ status, isSending, isCommandRunning })) {
        setDraft(`${skillSlashText(skillName)} `);
        return;
      }
      pinnedRef.current = true;
      void sendChatInput(skillSlashText(skillName), { skills: skillsState.skills });
    },
    [status, isSending, isCommandRunning, setDraft, sendChatInput, skillsState.skills],
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

  const spendSurfaceKey =
    surface.kind === 'bot'
      ? `bot:${surface.botId}`
      : surface.kind === 'configurable'
        ? `cfg:${selectedBackendId ?? ''}`
        : undefined;
  const spendRefreshKey = threadSpendRefreshKey({
    surfaceKey: spendSurfaceKey,
    sessionId: currentSessionId,
    sending: isSending,
  });
  // The retry tick is the only non-derived input: bumping it re-runs the
  // spend effect below with the same `sessions.list` read. A bump while
  // disconnected is harmless — the effect early-returns and the new key
  // re-reads on the next connect.
  const spendEffectKey = spendRefreshKey ? `${spendRefreshKey}:retry${spendRetryTick}` : undefined;
  const handleSpendRetry = useCallback(() => {
    setSpendRetryTick((tick) => tick + 1);
  }, []);
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
  const handleRoutinesRetry = useCallback(() => {
    if (!botSurfaceId || status !== 'connected') return;
    const target = botSurfaceId;
    void botJobs
      .list()
      .then((jobs) =>
        setRoutineState((prev) => {
          const previous = prev.botId === target ? prev : { ...EMPTY_ROUTINES, botId: target };
          return { botId: target, ...applyRoutineRead(previous, { ok: true, jobs: routineJobsFromList(jobs) }) };
        }),
      )
      .catch(() =>
        setRoutineState((prev) => {
          const previous = prev.botId === target ? prev : { ...EMPTY_ROUTINES, botId: target };
          return { botId: target, ...applyRoutineRead(previous, { ok: false }) };
        }),
      );
  }, [botSurfaceId, status, botJobs]);
  // The routine actions that RoutinesPane takes as props must keep the
  // same identity across re-renders so the pane's `React.memo` wrapper can
  // hold: chat-screen ticks that do not change `surface.botId`, `botJobs`,
  // `foldRoutineRead`, or `routineJobsFromList` leave these callbacks alone,
  // and a memoized child renders only when its props change. The bodies are
  // byte-identical to the inline closures they replaced — only the closure
  // identity moves; the call graph (`botJobs.create`/`pause`/`.list()`
  // in the same order) is unchanged. The early-return on a non-bot surface
  // is defensive — BotChrome only renders for `surface.kind === 'bot'`, so
  // the user-invoked path cannot hit it, but `useCallback` keeps the deps
  // honest by keying on `botSurfaceId` (string | undefined) instead of the
  // whole `surface` object. A routine row tap no longer runs the job — it
  // opens the same CronJobSheet Activity renders, whose Run now / Pause /
  // Remove re-list through the existing `handleRoutinesRetry` re-read, so
  // there is no run callback to stabilize here.
  const handleRoutineCreate = useCallback(
    async (input: { title: string; prompt: string; schedule: string }) => {
      if (!botSurfaceId) return;
      const target = botSurfaceId;
      const created = await botJobs.create({
        name: routineName(target, input.title),
        prompt: input.prompt,
        schedule: input.schedule,
      });
      // The create landed: schedule the phone-side local notice from the
      // record the gateway returned, fire-and-forget so a locked scheduler
      // never reads as a refused create.
      if (created?.id) void syncRoutineNotification({ ...created, schedule: input.schedule });
      // Create already landed; a failed re-list must not look like
      // the Gate refused the job (that would keep the draft of a
      // routine that exists). Last-good stays; staleness is named.
      await botJobs
        .list()
        .then((jobs) =>
          foldRoutineRead(target, { ok: true, jobs: routineJobsFromList(jobs) }),
        )
        .catch(() => foldRoutineRead(target, { ok: false }));
    },
    [botSurfaceId, botJobs, foldRoutineRead, routineJobsFromList],
  );
  const handleRoutineTogglePause = useCallback(
    async (jobId: string, paused: boolean) => {
      await botJobs.pause(jobId, paused);
      // A pause retires the held notice up front (the sync below schedules
      // nothing for a paused job); a resume rebuilds it from the re-read.
      // Fire-and-forget: never read as a refused pause/resume.
      if (paused) void cancelRoutineNotification(jobId);
      await botJobs
        .list()
        .then((jobs) => {
          if (paused) return;
          const job = routineJobsFromList(jobs).find((candidate) => candidate.id === jobId);
          if (job) void syncRoutineNotification(job);
        })
        .then((jobs) =>
          foldRoutineRead(botSurfaceId ?? '', { ok: true, jobs: routineJobsFromList(jobs) }),
        )
        .catch(() => foldRoutineRead(botSurfaceId ?? '', { ok: false }));
    },
    [botSurfaceId, botJobs, foldRoutineRead, routineJobsFromList],
  );
  useEffect(() => {
    if (!botSurfaceId || status !== 'connected') return;
    let cancelled = false;
    void botJobs
      .list()
      .then((jobs) => {
        if (cancelled) return;
        const read = routineJobsFromList(jobs);
        foldRoutineRead(botSurfaceId, { ok: true, jobs: read });
        // This read is the only one that carries this Bot's routines and the
        // gateway's CURRENT next fire for each: re-arm their one-shot notices
        // from it, so a cadence beyond the two repeating shapes that already
        // fired is rebuilt the moment the operator opens the Bot Chat. Same
        // helper and same must-still as the provider's connected re-arm.
        void rearmRoutineNotifications(read);
      })
      .catch(() => {
        if (cancelled) return;
        foldRoutineRead(botSurfaceId, { ok: false });
      });
    return () => {
      cancelled = true;
    };
  }, [botSurfaceId, status, botJobs, foldRoutineRead]);

  const handleSkillsRetry = useCallback(() => {
    if (!botSurfaceId || status !== 'connected') return;
    const target = botSurfaceId;
    const fold = (read: Parameters<typeof applySkillsRead>[1]) => {
      setSkillsState((prev) => {
        const previous =
          prev.botId === target ? prev : { ...EMPTY_SKILLS, botId: target };
        return { botId: target, ...applySkillsRead(previous, read) };
      });
    };
    void gatewayRequest('skills.list')
      .then((payload) => fold(skillsReadFromUnknown(payload)))
      .catch(() => fold({ ok: false }));
  }, [botSurfaceId, status, gatewayRequest]);

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

  const handleToolsetsRetry = useCallback(() => {
    if (!toolsSurfaceKey || status !== 'connected') return;
    const target = toolsSurfaceKey;
    const kind = surface.kind;
    const backend = selectedBackendId;
    const fold = (read: Parameters<typeof applyToolsetsRead>[1]) => {
      setToolsetsState((prev) => {
        const previous =
          prev.surfaceKey === target ? prev : { ...EMPTY_TOOLSETS, surfaceKey: target };
        return { surfaceKey: target, ...applyToolsetsRead(previous, read) };
      });
    };
    void gatewayRequest('tools.list', toolsetsListParams({
      surfaceKind: kind,
      backendId: backend,
    }))
      .then((payload) => fold(toolsetsReadFromUnknown(payload)))
      .catch(() => fold({ ok: false }));
  }, [toolsSurfaceKey, status, surface.kind, selectedBackendId, gatewayRequest]);

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
    if (!spendEffectKey || !spendSurfaceKey || status !== 'connected') return;
    let cancelled = false;
    void gatewayRequest('sessions.list', { limit: SESSION_SPEND_LIST_LIMIT })
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
  }, [spendEffectKey, spendSurfaceKey, status, gatewayRequest]);

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

  // Bot Chat (and configurable chat) @-picks from the roster Bot ids, reusing
  // the group-room helper. TextField has no selection hook, so the caret is
  // the end of the draft — the same assumption group-room-view.tsx makes.
  const rosterBotIds = useMemo(() => rosterBots.map((bot) => bot.id), [rosterBots]);
  const mentionPicks = useMemo(
    () => (threadSurface ? mentionPicksAtCaret(draft, draft.length, rosterBotIds) : []),
    [draft, rosterBotIds, threadSurface],
  );
  const handleSelectMention = useCallback(
    (botId: string) => {
      setDraft(insertMention(draft, draft.length, botId));
    },
    [draft, setDraft],
  );
  const mentionDisplayName = useCallback(
    (botId: string) => rosterBots.find((bot) => bot.id === botId)?.displayName ?? botId,
    [rosterBots],
  );

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

  // Day dividers are decided here, once per message-array change, instead of
  // inside renderItem — renderMessage then depends on the stable callback set
  // only and keeps one identity for the whole streamed turn.
  const transcriptItems = useMemo<TranscriptItem[]>(
    () =>
      messages.map((message, index) => {
        const label = message.timestamp ? formatDayDividerCached(message.timestamp) : undefined;
        const previous = messages[index - 1];
        const previousLabel = previous?.timestamp ? formatDayDividerCached(previous.timestamp) : undefined;
        return { message, label, showDivider: !!label && label !== previousLabel };
      }),
    [messages],
  );

  const renderMessage = useCallback(
    ({ item }: { item: TranscriptItem }) => {
      return (
        <>
          {item.showDivider && item.label ? <DayDivider label={item.label} /> : null}
          <MessageBubble
            message={item.message}
            identity={identity}
            onRetry={retryCommand}
            onCancel={cancelCommand}
            onResume={handleResumeMessage}
            onLongPress={setActionMessage}
          />
        </>
      );
    },
    [cancelCommand, handleResumeMessage, identity, retryCommand],
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
    <Screen edges={screenEdgesFor({ platform: Platform.OS, hasDock: false })} parallaxY={parallaxY}>
      <ChatHeader
        gatewayName={settings.pcName ?? activeGateway.name}
        status={status}
        statusDetail={status === 'connected' ? undefined : statusDetail || probeMessage}
        streaming={isStreaming}
        sessionLabel={threadSurface ? sessionLabel : undefined}
        modelLabel={threadSurface ? modelLabel : undefined}
        onSessionPress={threadSurface ? handleHeaderSessionPress : undefined}
        onModelPress={threadSurface ? handleHeaderModelPress : undefined}
        onOverflowPress={threadSurface ? handleHeaderOverflowPress : undefined}
        backendLabel={
          surface.kind === 'bot'
            ? rosterRows.find((row): row is Extract<RosterRow, { kind: 'bot' }> => row.kind === 'bot' && row.bot.id === surface.botId)?.bot.displayName
              ?? selectedBotId
            : surface.kind === 'configurable'
              ? backendLabel
              : undefined
        }
        groupName={surface.kind === 'group' ? activeGroup?.name : undefined}
        onBackendPress={surface.kind === 'configurable' && backends.length > 0 ? handleHeaderBackendPress : undefined}
        onRosterPress={surface.kind === 'roster' ? undefined : handleHeaderRosterPress}
        backendsExpanded={backendPickerVisible}
        overflowExpanded={overflowVisible}
        // The speaker is this thread's own, and it is offered only where this
        // device has a voice: a conversation that cannot be read aloud shows
        // no control at all.
        speakerOn={threadSurface ? speakerOn : undefined}
        onSpeakerPress={
          threadSurface && speakerKey && speechReady ? handleSpeakerPress : undefined
        }
      />

      {silentHintShown ? (
        // The one-time silent-mode hint (B2): drawn under the header that
        // carries the speaker control, and only on the edge the speaker came
        // on — the store has already been told, so it is never owed again.
        <Text variant="micro" color="secondary" style={styles.silentHint}>
          {SILENT_MODE_HINT_COPY}
        </Text>
      ) : null}

      <NewAgentSheet
        key={editingBot ? `edit-${editingBot.id}` : 'create'}
        visible={newAgentVisible}
        busy={newAgentBusy}
        error={newAgentError}
        initial={editingBot ? botToEditInput(editingBot) : undefined}
        // The same normalized catalogue the chat model picker uses. Passing it
        // turns the bot's model pin from a hand-typed `provider/model-id` into a
        // pick, so a typo can no longer pin a model that does not exist.
        models={modelRows}
        onClose={() => {
          setNewAgentVisible(false);
          setEditingBot(null);
        }}
        onSubmit={(form) => {
          setNewAgentBusy(true);
          setNewAgentError(undefined);
          const target = editingBot;
          // Edit sends only what the form owns; null explicitly clears a model pin.
          const request = target
            ? updateBot({ id: target.id, ...buildBotUpdatePatch(form) })
            : createBot({ ...form, modelId: form.modelId ?? undefined, providerId: form.providerId ?? undefined });
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
        soul={detailBot && soulState.botId === detailBot.id ? soulState : undefined}
        onClose={() => setDetailBot(null)}
        onRetry={handleSoulRetry}
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

      {showPairingBanner ? (
        <PairingRequiredBanner onShow={() => setDismissedPairingKey(null)} />
      ) : null}

      {lastError ? (
        <LastErrorBanner
          error={lastError}
          onSetup={() => router.push('/gateway/setup' as Href)}
          onReconnect={() => void retryAutoConnect()}
          onDismiss={clearLastError}
        />
      ) : null}

      {threadSurface ? (
        <ThreadSpendGlance
          copy={
            spendState.surfaceKey === spendSurfaceKey
              ? threadSpendCopy(spendState, currentSessionId)
              : undefined
          }
          // The glance owns no fetch — the retry arrives as a prop, and only
          // on the failed-first-read state. A failed re-read keeps the last
          // good total with its own stale copy, so no button renders there.
          onRetry={
            spendState.surfaceKey === spendSurfaceKey && !spendState.loaded && spendState.failed
              ? handleSpendRetry
              : undefined
          }
        />
      ) : null}

      {botChromeCombined(surface) ? (
        <BotChrome
          // The voice this Bot's replies are read in: this device's own list
          // through the picker's fold, offered only where there is a Bot to key
          // a voice to (the fold answers no rows for a device with no voice, so
          // a platform that named none draws no Voice section). The refinement
          // rows under those chips are the same fold's answer for the voice
          // this Bot is stored with — a Bot stored with none is answered no
          // rows, so nothing is offered that could not be written.
          voiceOptions={botVoiceKey ? botVoiceChoices : undefined}
          onVoiceSelect={botVoiceKey ? handleBotVoiceSelect : undefined}
          voiceRefinements={botVoiceKey ? botVoiceRefinements : undefined}
          onVoiceRefine={botVoiceKey ? handleBotVoiceRefine : undefined}
        >
          <SkillsPane
            skills={skillsState.botId === surface.botId ? skillsState.skills : []}
            loaded={skillsState.botId === surface.botId ? skillsState.loaded : false}
            failed={skillsState.botId === surface.botId ? skillsState.failed : false}
            onInvoke={handleSkillInvoke}
            onRetry={handleSkillsRetry}
          />
          {toolsetsVisibleOn(surface) ? (
            <ToolsPane
              toolsets={toolsetsState.surfaceKey === toolsSurfaceKey ? toolsetsState.toolsets : []}
              loaded={toolsetsState.surfaceKey === toolsSurfaceKey ? toolsetsState.loaded : false}
              failed={toolsetsState.surfaceKey === toolsSurfaceKey ? toolsetsState.failed : false}
              onRetry={handleToolsetsRetry}
            />
          ) : null}
          <RoutinesPane
            jobs={routineState.botId === surface.botId ? routineState.jobs : []}
            loaded={routineState.botId === surface.botId ? routineState.loaded : false}
            failed={routineState.botId === surface.botId ? routineState.failed : false}
            onRetry={handleRoutinesRetry}
            onCreate={handleRoutineCreate}
            onTogglePause={handleRoutineTogglePause}
            onChanged={handleRoutinesRetry}
          />
        </BotChrome>
      ) : toolsetsVisibleOn(surface) ? (
        <ToolsPane
          toolsets={toolsetsState.surfaceKey === toolsSurfaceKey ? toolsetsState.toolsets : []}
          loaded={toolsetsState.surfaceKey === toolsSurfaceKey ? toolsetsState.loaded : false}
          failed={toolsetsState.surfaceKey === toolsSurfaceKey ? toolsetsState.failed : false}
          onRetry={handleToolsetsRetry}
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
              onAddMembers={(memberIds) =>
                botGroups.addMembers(activeGroup.id, memberIds).then((room) => {
                  // The Gate's answer is the truth: refresh the roster copy
                  // behind the room so the member chips show the joined
                  // roster, same as the roster detail sheet's add path.
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
          data={transcriptItems}
          keyExtractor={(item) => item.message.id}
          style={styles.list}
          contentContainerStyle={[
            styles.messages,
            { paddingBottom: chatTranscriptContentPaddingBottom({ platform: Platform.OS, insetBottom: insets.bottom }) },
          ]}
          onScroll={handleScroll}
          scrollEventThrottle={16}
          removeClippedSubviews
          initialNumToRender={12}
          maxToRenderPerBatch={16}
          windowSize={9}
          onContentSizeChange={handleContentSizeChange}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          renderItem={renderMessage}
          ListHeaderComponent={
            hasMoreHistory && messages.length > 0 ? (
              <View style={styles.loadEarlierWrap}>
                <Button
                  label={loadingEarlierHistory ? 'Loading…' : 'Load earlier messages'}
                  variant="ghost"
                  size="md"
                  disabled={loadingEarlierHistory}
                  busy={loadingEarlierHistory}
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
                actionLabel={status !== 'connected' ? 'Reconnect' : undefined}
                onAction={status !== 'connected' ? () => void retryAutoConnect() : undefined}
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
          <Animated.View
            entering={entering.fadeIn.duration(Motion.duration.fast)}
            style={[styles.jumpWrap, { bottom: chatJumpBottom({ platform: Platform.OS, insetBottom: insets.bottom }) }]}>
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
        onSend={handleSend}
        onStop={stopStreaming}
        slashSuggestions={slashSuggestions}
        onSelectSlashSuggestion={setDraft}
        mentionPicks={mentionPicks}
        onSelectMention={handleSelectMention}
        mentionDisplayName={mentionDisplayName}
        onBrowseCommands={openPalette}
        quickActions={quickActions}
        isStreaming={isStreaming}
        status={status}
        queuedCount={queuedCount}
        // The cursor a Bot Chat link asked for lands in this field; the screen
        // owns the handle and focuses it only on the Bot Chat the link named.
        inputRef={composerInputRef}
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
        spendCopy={
          spendState.surfaceKey === spendSurfaceKey
            ? overflowSpendCopy(spendState, currentSessionId)
            : undefined
        }
        spendSession={
          spendState.surfaceKey === spendSurfaceKey
            ? overflowSpendSession(spendState, currentSessionId)
            : undefined
        }
        sessions={
          spendState.surfaceKey === spendSurfaceKey && spendState.loaded
            ? spendState.sessions
            : []
        }
        rowCount={
          spendState.surfaceKey === spendSurfaceKey && spendState.loaded
            ? spendState.rowCount
            : 0
        }
        onReloadHistory={() => void reloadHistory()}
        onNewSession={() => handleThreadConfigSwitch(overflowNewSessionHop())}
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
        sessionsLoaded={sessionListLoaded}
        gatewayId={activeGateway.id}
        currentSessionId={currentSessionId}
        onSelectSession={selectSession}
        onRefreshSessions={() => void openSessionSelector()}
        hasMoreSessions={sessionListHasOlder}
        loadingOlderSessions={loadingOlderSessions}
        onShowOlderSessions={() => void loadOlderSessions()}
        onNewSession={(title) => void createNewSession(title)}
        onDeleteSession={(sessionId) => void deleteSessionById(sessionId)}
        onOpenSessionById={handleOpenSessionById}
        models={modelRows}
        modelsError={modelCatalogError}
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
  pairingBanner: {
    gap: Spacing.two,
  },
  // The one-time silent-mode hint sits under the header card, aligned with it.
  silentHint: {
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.two,
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
