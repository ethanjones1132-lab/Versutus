import * as Haptics from 'expo-haptics';
import { memo, useEffect, useRef, useState, useSyncExternalStore, type Ref } from 'react';
import { Keyboard, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ComposerKeyboardLift } from '@/components/layout/ComposerKeyboardLift';
import { Badge, Card, Icon, PressableScale, Text, TextField, type IconName, type TextFieldHandle } from '@/components/ui';
import { FontFamily, Radius, Spacing } from '@/constants/tokens';
import { composerCopy, composerDockUtilities } from '@/lib/gateway/composer-copy';
import { spokenDraftHold, type SpokenDraftHold } from '@/lib/gateway/composer-draft';
import type { SlashCommandSuggestion } from '@/lib/gateway/slash-commands';
import type { ConnectionStatus } from '@/lib/gateway/types';
import { haptics } from '@/lib/haptics';
import { chatComposerKeyboardOffset } from '@/lib/motion/chat-composer-layout';
import {
  chatComposerPaletteMaxHeight,
  chatComposerPaletteScrollMaxHeight,
} from '@/lib/motion/chat-composer-palette';
import { springSnappy } from '@/lib/motion/presets';
import {
  HANDSFREE_MIC_LOCK_COPY,
  HANDSFREE_START_LABEL,
} from '@/lib/voice/handsfree-call-copy';
import { micControlState } from '@/lib/voice/mic-state';
import {
  speechRecognitionAvailable,
  speechRecognitionPermissionAskable,
  startSpeechRecognition,
  stopSpeechRecognition,
} from '@/lib/voice/speech-recognition';
import { useTokens } from '@/hooks/use-tokens';

type ChatComposerProps = {
  draft: string;
  onChangeText: (text: string) => void;
  onSend: () => void;
  onStop: () => void;
  slashSuggestions?: SlashCommandSuggestion[];
  onSelectSlashSuggestion?: (value: string) => void;
  /** Roster Bot ids matching the @token at the caret. Shown above the input. */
  mentionPicks?: string[];
  onSelectMention?: (botId: string) => void;
  /** Display name for a roster Bot id. Defaults to the id itself. */
  mentionDisplayName?: (botId: string) => string;
  /** Open the browsable command palette. Hidden when not provided. */
  onBrowseCommands?: () => void;
  /** One-tap command seeds shown in the dock's left slot while idle. */
  quickActions?: { label: string; draft: string; icon: IconName }[];
  isStreaming: boolean;
  canSend: boolean;
  status: ConnectionStatus;
  queuedCount?: number;
  /**
   * The input's own handle, for a host that has to put the cursor in it (a Bot
   * Chat link opens this composer and focuses it). `undefined` for every other
   * caller: the composer renders the same field with or without a handle.
   */
  inputRef?: Ref<TextFieldHandle>;
  /**
   * The hands-free call control, offered beside the mic only where the provider
   * says Start can succeed. `undefined` hides it.
   */
  onStartCall?: () => void;
  /**
   * A call is live for this thread: manual send and dictation are held so the
   * call's own auto-send is the only thing leaving the phone. The draft is not
   * cleared.
   */
  callActive?: boolean;
  /**
   * P1: open the image picker. The parent supplies it only when the selected
   * model declares image input, so no control is drawn that would send an
   * image a text model rejects.
   */
  onAttach?: () => void;
  /** P1: the images staged for the next send. */
  attachments?: { uri: string; name?: string }[];
  /** P1: drop one staged image before sending. */
  onRemoveAttachment?: (uri: string) => void;
};

export const ChatComposer = memo(function ChatComposer({
  draft,
  onChangeText,
  onSend,
  onStop,
  slashSuggestions = [],
  onSelectSlashSuggestion,
  mentionPicks = [],
  onSelectMention,
  mentionDisplayName,
  onBrowseCommands,
  quickActions = [],
  isStreaming,
  canSend,
  status,
  queuedCount,
  inputRef,
  onStartCall,
  callActive = false,
  onAttach,
  attachments = [],
  onRemoveAttachment,
}: ChatComposerProps) {
  const tokens = useTokens();
  const [focused, setFocused] = useState(false);
  // The `+` menu: every composer affordance the pill itself has no room for
  // (attach, hands-free call, the one-tap commands, browse) lives behind the
  // one borderless control on the pill's left, so the dock keeps no chip row
  // and no floating terminal on the thread.
  const [menuOpen, setMenuOpen] = useState(false);
  const [micDevice, setMicDevice] = useState({ available: false, permissionAskable: false });
  const sendWidth = useSharedValue(56);

  // What this phone can do about voice is a device answer the composer cannot
  // know until it asks: whether this build carries a recognizer, and whether a
  // hold can be offered on the phone at all (granted, or the platform will
  // still put its own dialog up). Read once, together, so the control is never
  // drawn from half an answer — before either lands there is no mic at all.
  useEffect(() => {
    let cancelled = false;
    void Promise.all([speechRecognitionAvailable(), speechRecognitionPermissionAskable()]).then(
      ([available, permissionAskable]) => {
        if (!cancelled) setMicDevice({ available, permissionAskable });
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const copy = composerCopy({ canSend, isStreaming, status, queuedCount });
  const dockUtilities = composerDockUtilities({ canBrowseCommands: Boolean(onBrowseCommands) });
  const micState = micControlState({
    available: micDevice.available,
    status,
    isStreaming,
    permissionAskable: micDevice.permissionAskable,
  });

  // The pill's trailing slot holds exactly one control: the mic holds the
  // empty draft, and the round send (Stop while a reply streams) takes the
  // slot the moment there is text. Nothing else draws beside the field, so
  // the placeholder keeps the whole line to itself at phone width.
  const showSend = draft.trim().length > 0 || isStreaming;
  // What the `+` menu can offer right now. With nothing to offer there is no
  // control to draw rather than a `+` that opens an empty panel.
  const canOpenMenu = Boolean(
    (onAttach && !callActive && !isStreaming) ||
      (onStartCall && !callActive) ||
      (quickActions.length > 0 && !isStreaming && !draft.trim()) ||
      (dockUtilities.includes('browse-commands') && onBrowseCommands),
  );

  const sendAnimatedStyle = useAnimatedStyle(() => ({
    minWidth: sendWidth.value,
  }));

  const handleAction = async () => {
    setMenuOpen(false);
    if (isStreaming) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      onStop();
      return;
    }
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onSend();
  };

  // The live hold, if any: the draft fold that owns the words, and whether the
  // finger has already come up. A release that lands while the phone is still
  // answering the microphone prompt must still end the session it started.
  const micHoldRef = useRef<{ hold: SpokenDraftHold; released: boolean } | null>(null);

  // The mic's two edges. Press-in starts a hold against the text the field
  // already held; press-out ends recognition and leaves what was said in the
  // draft, for review. The words land through the composer's own change
  // handler — the only writer on this path — and neither edge sends.
  const handleMicPressIn = () => {
    void haptics.light();
    const hold = spokenDraftHold(draft, onChangeText);
    const entry = { hold, released: false };
    micHoldRef.current = entry;

    void startSpeechRecognition({}, (transcript) => hold.onTranscript(transcript)).then((started) => {
      if (!started) {
        // Nothing is listening: a phone that refused, or a recognizer that
        // would not start, puts the text the hold began with back rather than
        // leaving half a draft nobody asked for.
        hold.onCancelled();
        if (micHoldRef.current === entry) micHoldRef.current = null;
        // A refused hold is a line rather than a quiet no-op — and only the
        // platform's own record is allowed to name the reason. The phone's
        // answer says whether a hold can be offered at all, so a microphone the
        // platform will not re-ask is drawn refused from here on, while a
        // recognizer that merely would not start claims nothing about the
        // microphone.
        void speechRecognitionPermissionAskable().then((askable) => {
          if (!askable) setMicDevice((device) => ({ ...device, permissionAskable: false }));
        });
        return;
      }
      if (entry.released) {
        // The finger came up while the phone was still answering: end the
        // session that just started, rather than leave a microphone listening
        // with nothing holding it.
        void stopSpeechRecognition();
      }
    });
  };

  const handleMicPressOut = () => {
    void haptics.light();
    const entry = micHoldRef.current;
    micHoldRef.current = null;
    if (!entry) return;
    entry.released = true;
    void stopSpeechRecognition();
  };

  // A live call holds manual send and dictation for its thread: speech is the
  // call's to send, and a typed draft is preserved untouched rather than
  // cleared.
  const isActionDisabled = callActive || !canSend || (!isStreaming && !draft.trim());
  // Input stays editable whenever the user can queue or send (including offline).
  const inputEditable = !callActive && canSend && !isStreaming;
  const micDisabled = callActive || micState.kind !== 'live';
  const micLabel = callActive
    ? HANDSFREE_MIC_LOCK_COPY
    : micState.kind === 'disabled'
      ? micState.reason
      : 'Hold to talk';

  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const kavOffset = chatComposerKeyboardOffset({
    platform: Platform.OS,
    topInset: insets.top,
  });
  const keyboardHeight = useSyncExternalStore(subscribeKeyboardHeight, getKeyboardHeight, () => 0);
  const paletteMaxHeight = chatComposerPaletteMaxHeight({
    windowHeight,
    insetTop: insets.top,
    insetBottom: insets.bottom,
    keyboardHeight,
  });
  const paletteScrollMaxHeight = chatComposerPaletteScrollMaxHeight({
    windowHeight,
    insetTop: insets.top,
    insetBottom: insets.bottom,
    keyboardHeight,
  });

  // Android owns IME lift via ComposerKeyboardLift (useAnimatedKeyboard) —
  // KAV with undefined behavior still participates in layout and is not needed.
  const composerInner = (
    <ComposerKeyboardLift>
      <View style={styles.dock}>
        {menuOpen && canOpenMenu ? (
          <View
            style={[
              styles.palette,
              { backgroundColor: tokens.backgroundRaised, borderColor: tokens.border, maxHeight: paletteMaxHeight },
            ]}>
            <Text variant="micro" color="tertiary" style={styles.paletteTitle}>
              Add
            </Text>
            <ScrollView
              style={[styles.paletteScroll, { maxHeight: paletteScrollMaxHeight }]}
              contentContainerStyle={styles.paletteContent}
              nestedScrollEnabled
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}>
              {onAttach && !callActive && !isStreaming ? (
                <PressableScale
                  style={[
                    styles.menuRow,
                    { backgroundColor: tokens.backgroundInset, borderColor: tokens.borderSubtle },
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel="Attach an image"
                  onPress={async () => {
                    await Haptics.selectionAsync();
                    setMenuOpen(false);
                    onAttach();
                  }}>
                  <Icon name={{ ios: 'photo', android: 'image', web: 'image' }} size={14} color="accent" />
                  <Text variant="caption" style={styles.menuLabel}>
                    Attach an image
                  </Text>
                </PressableScale>
              ) : null}
              {onStartCall && !callActive ? (
                <PressableScale
                  style={[
                    styles.menuRow,
                    { backgroundColor: tokens.backgroundInset, borderColor: tokens.borderSubtle },
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={HANDSFREE_START_LABEL}
                  onPress={async () => {
                    await Haptics.selectionAsync();
                    setMenuOpen(false);
                    onStartCall();
                  }}>
                  <Icon name={{ ios: 'phone.fill', android: 'call', web: 'call' }} size={14} color="accent" />
                  <Text variant="caption" style={styles.menuLabel}>
                    {HANDSFREE_START_LABEL}
                  </Text>
                </PressableScale>
              ) : null}
              {!isStreaming && !draft.trim() && quickActions.length > 0
                ? quickActions.map((action) => (
                    <PressableScale
                      key={action.label}
                      onPress={async () => {
                        await Haptics.selectionAsync();
                        setMenuOpen(false);
                        onSelectSlashSuggestion?.(action.draft);
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={`Quick action ${action.label}`}
                      style={[
                        styles.menuRow,
                        { backgroundColor: tokens.backgroundInset, borderColor: tokens.borderSubtle },
                      ]}>
                      <Icon name={action.icon} size={14} color="accent" />
                      <Text variant="caption" style={styles.menuLabel}>
                        {action.label}
                      </Text>
                    </PressableScale>
                  ))
                : null}
              {dockUtilities.includes('browse-commands') && onBrowseCommands ? (
                <PressableScale
                  onPress={async () => {
                    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    setMenuOpen(false);
                    onBrowseCommands();
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="Browse commands"
                  style={[
                    styles.menuRow,
                    { backgroundColor: tokens.backgroundInset, borderColor: tokens.borderSubtle },
                  ]}>
                  <Icon
                    name={{ ios: 'command', android: 'terminal', web: 'terminal' }}
                    size={14}
                    color="accent"
                  />
                  <Text variant="caption" style={styles.menuLabel}>
                    Browse commands
                  </Text>
                </PressableScale>
              ) : null}
            </ScrollView>
          </View>
        ) : null}

        {mentionPicks.length > 0 && onSelectMention ? (
          <View
            style={[
              styles.palette,
              { backgroundColor: tokens.backgroundRaised, borderColor: tokens.border, maxHeight: paletteMaxHeight },
            ]}>
            <Text variant="micro" color="tertiary" style={styles.paletteTitle}>
              Mention
            </Text>
            <ScrollView
              style={[styles.paletteScroll, { maxHeight: paletteScrollMaxHeight }]}
              contentContainerStyle={styles.paletteContent}
              nestedScrollEnabled
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}>
              {mentionPicks.map((botId) => {
                const label = mentionDisplayName?.(botId) ?? botId;
                return (
                  <PressableScale
                    key={botId}
                    style={[
                      styles.paletteItem,
                      {
                        backgroundColor: tokens.backgroundInset,
                        borderColor: tokens.borderSubtle,
                      },
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel={`Mention ${label}`}
                    onPress={async () => {
                      await Haptics.selectionAsync();
                      onSelectMention(botId);
                    }}>
                    <View style={styles.paletteRow}>
                      <Text variant="caption" numberOfLines={1} style={styles.paletteLabel}>
                        @{botId}
                      </Text>
                    </View>
                    {label !== botId ? (
                      <Text variant="micro" color="tertiary" numberOfLines={1} style={styles.paletteDesc}>
                        {label}
                      </Text>
                    ) : null}
                  </PressableScale>
                );
              })}
            </ScrollView>
          </View>
        ) : null}

        {slashSuggestions.length > 0 ? (
          <View
            style={[
              styles.palette,
              { backgroundColor: tokens.backgroundRaised, borderColor: tokens.border, maxHeight: paletteMaxHeight },
            ]}>
            <Text variant="micro" color="tertiary" style={styles.paletteTitle}>
              Commands
            </Text>
            <ScrollView
              style={[styles.paletteScroll, { maxHeight: paletteScrollMaxHeight }]}
              contentContainerStyle={styles.paletteContent}
              nestedScrollEnabled
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}>
              {slashSuggestions.map((item) => {
                const unavailable = item.unavailable;
                const danger = item.danger === 'write' || item.danger === 'destructive';
                return (
                  <PressableScale
                    key={item.value}
                    style={[
                      styles.paletteItem,
                      {
                        backgroundColor: tokens.backgroundInset,
                        borderColor: danger ? tokens.accentWarmMuted : tokens.borderSubtle,
                        opacity: unavailable ? 0.55 : 1,
                      },
                    ]}
                    disabled={unavailable}
                    accessibilityRole="button"
                    accessibilityLabel={`Command ${item.label}`}
                    accessibilityState={{ disabled: unavailable }}
                    onPress={async () => {
                      if (!unavailable) {
                        await Haptics.selectionAsync();
                        onSelectSlashSuggestion?.(item.value);
                      }
                    }}>
                    <View style={styles.paletteRow}>
                      <Text variant="caption" numberOfLines={1} style={styles.paletteLabel}>
                        {item.label}
                      </Text>
                      {item.danger === 'destructive' ? (
                        <Icon
                          name={{ ios: 'exclamationmark.triangle.fill', android: 'warning', web: 'warning' }}
                          size={11}
                          color="statusDisconnected"
                        />
                      ) : item.danger === 'write' ? (
                        <Icon
                          name={{ ios: 'exclamationmark.triangle', android: 'warning', web: 'warning' }}
                          size={11}
                          color="statusConnecting"
                        />
                      ) : null}
                      {item.family ? <Badge label={item.family} dot={false} /> : null}
                    </View>
                    <Text variant="micro" color="tertiary" numberOfLines={1} style={styles.paletteDesc}>
                      {item.description}
                      {unavailable ? ' (unavailable)' : ''}
                    </Text>
                  </PressableScale>
                );
              })}
              {onBrowseCommands ? (
                <PressableScale
                  style={[
                    styles.paletteItem,
                    { backgroundColor: 'transparent', borderColor: tokens.borderSubtle },
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel="Browse all commands"
                  onPress={async () => {
                    await Haptics.selectionAsync();
                    onBrowseCommands();
                  }}>
                  <View style={styles.paletteRow}>
                    <Text variant="caption" color="accent" numberOfLines={1} style={styles.paletteLabel}>
                      Browse all commands
                    </Text>
                    <Icon
                      name={{ ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' }}
                      size={11}
                      color="textTertiary"
                    />
                  </View>
                  <Text variant="micro" color="tertiary" numberOfLines={1} style={styles.paletteDesc}>
                    This list is capped — the palette groups every command by family.
                  </Text>
                </PressableScale>
              ) : null}
            </ScrollView>
          </View>
        ) : null}

        {attachments.length > 0 ? (
          <View style={styles.attachmentRow}>
            {attachments.map((attachment) => (
              <PressableScale
                key={attachment.uri}
                style={[
                  styles.attachmentChip,
                  { backgroundColor: tokens.backgroundInset, borderColor: tokens.border },
                ]}
                accessibilityRole="button"
                accessibilityLabel={`Remove ${attachment.name ?? 'image'}`}
                onPress={() => onRemoveAttachment?.(attachment.uri)}>
                <Icon name={{ ios: 'photo', android: 'image', web: 'image' }} size={12} color="textSecondary" />
                <Text variant="micro" color="secondary" numberOfLines={1} style={styles.attachmentName}>
                  {attachment.name ?? 'image'}
                </Text>
                <Icon name={{ ios: 'xmark', android: 'close', web: 'close' }} size={11} color="textTertiary" />
              </PressableScale>
            ))}
          </View>
        ) : null}

        <Card
          padding={Spacing.one}
          style={[
            styles.pill,
            { borderColor: focused ? tokens.accentWarm : tokens.border },
          ]}>
          {canOpenMenu ? (
            // The one control on the left: borderless, and the door to the
            // affordances the pill has no room to draw inline (attach, call,
            // the one-tap commands, browse).
            <PressableScale
              onPress={async () => {
                await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                setMenuOpen((open) => !open);
              }}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel="Add image or command"
              style={styles.plusButton}>
              <Icon
                name={{ ios: 'plus', android: 'add', web: 'add' }}
                size={20}
                color={menuOpen ? 'accent' : 'textSecondary'}
              />
            </PressableScale>
          ) : null}
          <TextField
            inputRef={inputRef}
            value={draft}
            onChangeText={onChangeText}
            placeholder={copy.placeholder}
            multiline
            editable={inputEditable}
            // Chat keeps the platform typing defaults — the kit's form defaults
            // (none / no autocorrect) are for URLs and tokens, not prose.
            autoCapitalize="sentences"
            autoCorrect={true}
            onFocus={() => {
              setFocused(true);
              // The field taking the cursor is the operator typing, not
              // reading the menu: the panel leaves with the keyboard up.
              setMenuOpen(false);
            }}
            onBlur={() => setFocused(false)}
            accessibilityLabel="Message input"
            style={styles.input}
          />
          {!showSend && micState.kind !== 'hidden' ? (
            // The empty pill's trailing control: drawn from the one fold and
            // nothing else — dimmed with the module's own reason line while
            // the gateway is away, live while it is connected. A build with
            // no recognizer draws no mic at all.
            <PressableScale
              style={[styles.micButton, micDisabled && styles.micDisabled]}
              disabled={micDisabled}
              onPressIn={handleMicPressIn}
              onPressOut={handleMicPressOut}
              accessibilityRole="button"
              accessibilityLabel={micLabel}>
              <Icon
                name={{ ios: 'mic.fill', android: 'mic', web: 'mic' }}
                size={18}
                color={!micDisabled ? 'accent' : 'textTertiary'}
              />
            </PressableScale>
          ) : null}
          {showSend ? (
            // The mic's own slot once there is text: the round send, and the
            // same round Stop while a reply is streaming.
            <Animated.View style={sendAnimatedStyle}>
              <PressableScale
                style={[
                  styles.sendButton,
                  {
                    backgroundColor: isStreaming ? tokens.accentWarm : tokens.accent,
                    borderColor: tokens.accentWarm,
                  },
                  isActionDisabled && styles.sendDisabled,
                ]}
                onPress={() => void handleAction()}
                disabled={isActionDisabled}
                accessibilityRole="button"
                accessibilityLabel={copy.sendLabel}
                accessibilityState={{ disabled: isActionDisabled, busy: isStreaming }}
                onPressIn={() => {
                  // Reanimated shared value — mutable by design, not React state.
                  // eslint-disable-next-line react-hooks/immutability
                  sendWidth.value = withSpring(isStreaming ? 68 : 52, springSnappy);
                }}
                onPressOut={() => {
                  // Reanimated shared value — mutable by design, not React state.
                  // eslint-disable-next-line react-hooks/immutability
                  sendWidth.value = withSpring(56, springSnappy);
                }}>
                <Icon
                  name={
                    isStreaming
                      ? { ios: 'stop.fill', android: 'stop', web: 'stop' }
                      : { ios: 'arrow.up', android: 'arrow_upward', web: 'arrow_upward' }
                  }
                  size={16}
                  color="textInverse"
                />
              </PressableScale>
            </Animated.View>
          ) : null}
        </Card>

        {!showSend && micState.kind !== 'hidden' && micDisabled ? (
          // The mic says why it cannot be held, in the module's own words:
          // a dimmed control on its own is silence, and silence about a
          // microphone reads as a broken one. A live call states its own lock.
          <Text variant="micro" color="tertiary" style={styles.micReason}>
            {micLabel}
          </Text>
        ) : null}
      </View>
    </ComposerKeyboardLift>
  );

  if (Platform.OS !== 'ios') return composerInner;

  return (
    <KeyboardAvoidingView behavior="padding" keyboardVerticalOffset={kavOffset}>
      {composerInner}
    </KeyboardAvoidingView>
  );
});

function subscribeKeyboardHeight(onChange: () => void) {
  const show = Keyboard.addListener('keyboardDidShow', onChange);
  const hide = Keyboard.addListener('keyboardDidHide', onChange);
  const frame = Keyboard.addListener('keyboardDidChangeFrame', onChange);
  return () => {
    show.remove();
    hide.remove();
    frame.remove();
  };
}

function getKeyboardHeight(): number {
  const height = Keyboard.metrics()?.height;
  return typeof height === 'number' && Number.isFinite(height) ? height : 0;
}

const styles = StyleSheet.create({
  dock: {
    paddingBottom: Spacing.two,
    gap: Spacing.two,
  },
  palette: {
    marginHorizontal: Spacing.four,
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    maxHeight: 180,
  },
  paletteTitle: {
    paddingHorizontal: Spacing.three - 4,
    paddingTop: Spacing.two,
    textTransform: 'uppercase',
  },
  paletteScroll: {
    maxHeight: 150,
  },
  paletteContent: {
    padding: Spacing.one,
    gap: Spacing.one,
  },
  paletteItem: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one + 2,
    gap: 2,
  },
  paletteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  paletteLabel: {
    flex: 1,
    fontFamily: FontFamily.sansSemiBold,
  },
  paletteDesc: {
    paddingRight: Spacing.two,
  },
  // The one pill: a single rounded row the field sits in. `+` on the left,
  // the field, and one trailing control (mic, or the round send once there
  // is text) — no chip row, no floating terminal, no boxed button cluster.
  pill: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: Spacing.one,
    marginHorizontal: Spacing.four,
    borderRadius: Radius.full,
  },
  plusButton: {
    width: 36,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.full,
  },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    minHeight: 44,
    paddingHorizontal: Spacing.two,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  menuLabel: {
    flex: 1,
  },
  attachmentRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.one,
    marginHorizontal: Spacing.four,
    marginBottom: Spacing.one,
  },
  attachmentChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    maxWidth: 160,
  },
  attachmentName: {
    flexShrink: 1,
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 140,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
    // The pill's Card owns the chrome (focus-driven border, Radius.full);
    // the kit field renders bare inside it. No horizontal padding beyond
    // this: the placeholder keeps the whole line at 375px.
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderRadius: 0,
  },
  sendButton: {
    borderRadius: Radius.full,
    minHeight: 48,
    paddingHorizontal: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  sendDisabled: {
    opacity: 0.5,
  },
  // The mic is the empty pill's trailing control: a borderless round glyph
  // in the slot the send takes once there is text. It carries no fill and no
  // hairline — a hold is a secondary action, and only its glyph is lit.
  micButton: {
    width: 44,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.full,
  },
  micDisabled: {
    opacity: 0.5,
  },
  micReason: {
    paddingHorizontal: Spacing.four,
  },
});
