import * as Clipboard from 'expo-clipboard';
import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Switch, View } from 'react-native';

import { BaseSheet, Button, Divider, ListRow, Skeleton, Text, TextField } from '@/components/ui';
import { Spacing } from '@/constants/tokens';
import { haptics } from '@/lib/haptics';
import { describeBotDetail } from '@/lib/gateway/bot-detail';
import {
  BOT_PACKET_EXCLUDED_COPY,
  botPacketManifest,
  buildBotPacket,
} from '@/lib/gateway/bot-packet';
import { botSoulCopy, EMPTY_BOT_SOUL, type BotSoulState, type PublicBot } from '@/lib/gateway/bots';
import { memoryStatusCopy, type MemoryStatusState } from '@/lib/gateway/memory-status';
import {
  approvalPolicyDraft,
  APPROVAL_POLICY_LIMIT_COPY,
  type ApprovalPolicy,
} from '@/lib/settings/approval-policy';

export type BotDetailSheetProps = {
  /** The Bot to describe; null renders nothing (sheet dismissed). */
  bot: PublicBot | null;
  /**
   * This Bot's standing instructions, read on demand by the parent. Absent on
   * a Gate that cannot serve `bots.get`, which renders as an honest "could not
   * be read" rather than as "this Bot has none".
   */
  soul?: BotSoulState;
  /**
   * This Bot's memory-doctor status, read on demand by the parent (the same
   * `doctor.memory.status` reply the `/memory` slash line renders). Absent
   * renders no Memory row at all — no control without a read to show, the
   * established capability-gated pattern.
   */
  memory?: MemoryStatusState;
  onClose: () => void;
  /**
   * Opens this Bot's chat — the parent owns that navigation (same path a
   * roster tap takes). Hidden for Bots the routing verdict refuses, so the
   * row never invites a guaranteed send failure.
   */
  onMessage?: () => void;
  /**
   * Opens the edit form prefilled with this Bot — the parent owns that sheet.
   * The row hides itself for the default profile, which the Gate refuses to
   * edit (ADR 0011).
   */
  onEdit?: () => void;
  /**
   * Re-run the same `bots.get` read the detail effect runs. Rendered only
   * on the failed-first-read soul path, so no button without a handler
   * and none over a loaded soul.
   */
  onRetry?: () => void;
  /**
   * Exports this Bot as a handoff packet — the sheet composes the pure
   * packet fold with the share seam it is given, so the packet code never
   * touches the platform and the surface stays the offer. Rendered only
   * with a handler.
   */
  onExportPacket?: () => void;
  /**
   * Reads a handoff packet file back against THIS gateway — validate-first
   * per the spec, answering what would and would not land before anything
   * applies. Nothing is written by reading: the composition lives in the
   * parent (it owns this gateway's model catalog), so the sheet stays the
   * surface. Rendered only with a handler, which the parent arms only for
   * a connected gateway — a note about what would land needs the gateway
   * to be there.
   */
  onImportPacket?: () => void;
  /**
   * Applies the last-read packet as a new Bot, riding the pure
   * `applyBotPacket` fold the parent composes with its own `createBot`
   * seam. Armed only when the fold says the gateway would accept the
   * packet (management gate + a matched-or-absent pin) — otherwise no arm
   * and the note stays the whole outcome. `busy` while the write runs.
   */
  onApplyPacket?: (() => void) | null;
  applyPacketBusy?: boolean;
  /**
   * The read-back's answer, shown as a fact — what would land, what would
   * not, and (always next to it) what never travels. Null renders nothing,
   * so a sheet that has not asked yet shows no answer.
   */
  packetReadNote?: string | null;
  /**
   * Reads and writes this Bot's approval policy. The store write is
   * `setBotApprovalPolicy` — the seam the provider's enforced verdict reads
   * back. Rendered only with both, so a surface without the write seam is
   * a read-only sheet exactly as before.
   */
  onLoadApprovalPolicy?: (botId: string) => Promise<ApprovalPolicy | null>;
  onSaveApprovalPolicy?: (botId: string, policy: ApprovalPolicy | null) => Promise<void>;
};

/**
 * The roster row's detail surface: description, model pin, routing state
 * with its fix, and the profile id. Everything here was already on the
 * roster payload — long-press a row to read what one line cannot carry,
 * then act: message the agent, copy the id for host-side commands, or edit
 * what the Gate holds.
 */
export function BotDetailSheet({ bot, soul, memory, onClose, onMessage, onEdit, onRetry, onExportPacket, onImportPacket, onApplyPacket, applyPacketBusy, packetReadNote, onLoadApprovalPolicy, onSaveApprovalPolicy }: BotDetailSheetProps) {
  if (!bot) return null;
  const detail = describeBotDetail(bot);
  const soulState = soul ?? EMPTY_BOT_SOUL;
  const soulNote = botSoulCopy(soulState);

  const handleCopyId = async () => {
    await Clipboard.setStringAsync(detail.id);
    await haptics.success();
  };

  return (
    <BaseSheet
      visible
      eyebrow="AGENT"
      title={detail.name}
      onClose={onClose}
      closeLabel="Dismiss">
      <ScrollView
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scroll}>
        {detail.description ? (
          <Text variant="body" color="secondary" style={styles.description}>
            {detail.description}
          </Text>
        ) : (
          <Text variant="caption" color="tertiary" style={styles.description}>
            No description yet.
          </Text>
        )}

        <View style={styles.facts}>
          <View style={styles.fact}>
          <Text variant="micro" color="tertiary">
            SOUL
          </Text>
          {soulState.soul ? (
            <Text variant="body" color="secondary">
              {soulState.soul.trim()}
            </Text>
          ) : null}
          {soulNote ? (
            <Text variant="caption" color={soulState.failed ? 'accentWarm' : 'tertiary'}>
              {soulNote}
            </Text>
          ) : null}
          {!soulState.loaded && !soulState.failed ? (
            <Skeleton width="90%" height={44} />
          ) : null}
          {!soulState.loaded && soulState.failed && onRetry ? (
            <Button label="Retry" variant="ghost" size="sm" onPress={onRetry} />
          ) : null}
        </View>

        {memory ? (
          <View style={styles.fact}>
            <Text variant="micro" color="tertiary">
              MEMORY
            </Text>
            {/* Read-first: the doctor's own line, never an edit affordance. */}
            <Text variant="caption" color="secondary">
              {memoryStatusCopy(memory)}
            </Text>
          </View>
        ) : null}

        <View style={styles.fact}>
          <Text variant="micro" color="tertiary">
            MODEL PIN
          </Text>
          {detail.modelPin ? (
            <Text variant="body">{detail.modelPin}</Text>
          ) : (
            <Text variant="body" color="secondary">
              Unpinned — uses the gateway default
            </Text>
          )}
        </View>

        <View style={styles.fact}>
          <Text variant="micro" color="tertiary">
            ROUTING
          </Text>
          <Text variant="body" color={detail.routingNext ? 'accentWarm' : undefined}>
            {detail.routingTitle}
          </Text>
          {detail.routingNext ? (
            <Text variant="caption" color="secondary">
              {detail.routingNext}
            </Text>
          ) : null}
        </View>

        <ApprovalPolicySection
          botName={detail.name}
          botId={detail.id}
          onLoad={onLoadApprovalPolicy}
          onSave={onSaveApprovalPolicy}
        />

        <Divider />
        <View style={styles.fact}>
          <Text variant="micro" color="tertiary">
            PROFILE ID
          </Text>
          <Text variant="mono">{detail.id}</Text>
        </View>

        {onMessage && detail.messagable ? (
          <ListRow
            title={`Message ${detail.name}`}
            subtitle="Open this agent's chat"
            icon={{ ios: 'bubble.left.and.bubble.right', android: 'chat', web: 'chat' }}
            chevron={false}
            onPress={onMessage}
          />
        ) : null}
        <ListRow
          title="Copy profile id"
          subtitle="For host-side hermes -p commands"
          icon={{ ios: 'doc.on.doc', android: 'content_copy', web: 'content_copy' }}
          chevron={false}
          onPress={() => void handleCopyId()}
        />
        {onExportPacket ? (
          <ListRow
            title="Export handoff packet"
            subtitle={botPacketManifest(buildBotPacket(bot, soulState))}
            icon={{ ios: 'square.and.arrow.up', android: 'share', web: 'share' }}
            chevron={false}
            onPress={onExportPacket}
          />
        ) : null}
        {packetReadNote ? (
          <View style={styles.fact}>
            <Text variant="micro" color="tertiary">
              PACKET
            </Text>
            <Text variant="caption" color="secondary">
              {packetReadNote}
            </Text>
          </View>
        ) : null}
        {/* The apply arm: the same handoff area, one gate-checked button
            below the read-back note. Explicitly `null` and `undefined` are
            the same "no affordance" — the parent arms it only when the
            apply fold says the gateway would accept the packet. */}
        {packetReadNote && onApplyPacket ? (
          <Button
            label="Apply as new Bot"
            variant="primary"
            size="sm"
            busy={applyPacketBusy}
            onPress={onApplyPacket}
          />
        ) : null}
        {onImportPacket ? (
          <ListRow
            title="Read back a packet"
            subtitle={`See what a picked packet would land on ${detail.name}. ${BOT_PACKET_EXCLUDED_COPY} Nothing applies.`}
            icon={{ ios: 'square.and.arrow.down', android: 'download', web: 'download' }}
            chevron={false}
            onPress={onImportPacket}
          />
        ) : null}
        {onEdit && detail.editable ? (
          <ListRow
            title="Edit agent"
            subtitle="Description, soul, and model pin"
            icon={{ ios: 'pencil', android: 'edit', web: 'edit' }}
            chevron={false}
            onPress={onEdit}
          />
        ) : null}
      </View>
      </ScrollView>
    </BaseSheet>
  );
}

/**
 * The enforced engine's editing surface: this Bot's approval policy, kept
 * in phone-side storage and read back at the approval-waiting point by the
 * provider's `approvalPolicyVerdict`. Armed only when the parent supplied
 * both the read and the write seam, so the sheet degrades to read-only
 * exactly as before — no control without a write to finish it. The toggle
 * and the commands field are drafts the save commits through the pure
 * `approvalPolicyDraft` fold, so the store never sees a text it must
 * re-parse and a list the verdict would not read.
 */
function ApprovalPolicySection({ botName, botId, onLoad, onSave }: {
  botName: string;
  botId: string;
  onLoad?: (botId: string) => Promise<ApprovalPolicy | null>;
  onSave?: (botId: string, policy: ApprovalPolicy | null) => Promise<void>;
}) {
  const [state, setState] = useState<{ phase: 'loading' | 'ready' | 'failed' }>({
    phase: 'loading',
  });
  const [draftText, setDraftText] = useState('');
  const [draftEnabled, setDraftEnabled] = useState(false);
  const [busy, setBusy] = useState(false);

  // The editor is seeded only from the store's own read: the draft fields
  // hold the stored policy's texts, or the honest blank policy for a Bot
  // that has none. `phase` moves to 'ready' when the answer lands, so the
  // surface authors no position of its own while the read is in flight.
  useEffect(() => {
    if (!onLoad) return;
    let cancelled = false;
    void onLoad(botId)
      .then((policy) => {
        if (cancelled) return;
        if (policy) {
          setDraftEnabled(policy.enabled);
          setDraftText(policy.readOnlyCommands.join(', '));
        } else {
          setDraftEnabled(false);
          setDraftText('');
        }
        setState({ phase: 'ready' });
      })
      .catch(() => {
        // A refused read is a refused sheet section — the human path is
        // untouched, never a policy guessed from silence.
        if (!cancelled) setState({ phase: 'failed' });
      });
    return () => {
      cancelled = true;
    };
  }, [botId, onLoad]);

  const handleSave = useCallback(() => {
    if (!onSave || busy) return;
    const draft = approvalPolicyDraft(draftText, draftEnabled);
    setBusy(true);
    void (async () => {
      try {
        await onSave(botId, draft);
        await haptics.success();
      } finally {
        setBusy(false);
      }
    })();
  }, [botId, busy, draftEnabled, draftText, onSave]);

  const phase = state.phase;
  if (!onLoad || !onSave) return null;
  if (phase === 'failed') return null;

  return (
    <View style={styles.fact}>
      <View style={styles.policyRow}>
        <Text variant="micro" color="tertiary">
          APPROVAL POLICY
        </Text>
        {phase === 'loading' ? (
          <Skeleton width="40%" height={20} />
        ) : (
          <Switch value={draftEnabled} onValueChange={setDraftEnabled} />
        )}
      </View>
      {phase === 'ready' ? (
        <>
          <Text variant="caption" color="tertiary">
            {APPROVAL_POLICY_LIMIT_COPY}
          </Text>
          <TextField
            value={draftText}
            onChangeText={setDraftText}
            placeholder="list, read, journal:"
            multiline
          />
          <Button label={`Save ${botName}'s policy`} variant="ghost" size="sm" busy={busy} onPress={handleSave} />
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: {
    gap: Spacing.two,
    paddingBottom: Spacing.two,
  },
  description: {
    paddingHorizontal: Spacing.one,
    paddingBottom: Spacing.two,
  },
  facts: {
    gap: Spacing.two,
    paddingHorizontal: Spacing.one,
  },
  fact: {
    gap: 2,
  },
  policyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
});
