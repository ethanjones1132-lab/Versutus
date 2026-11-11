import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, ScrollView, StyleSheet, View } from 'react-native';

import { CouncilCompareView } from '@/components/chat/council-compare-view';
import { Button, Card, Chip, EmptyState, ErrorCard, Icon, PageTitle, PressableScale, Screen, Skeleton, Text, TextField } from '@/components/ui';
import { Radius, Spacing } from '@/constants/tokens';
import { useGateway } from '@/context/gateway-provider';
import type { PublicBot } from '@/lib/gateway/bots';
import {
  boundedOperation,
  clearPendingRoom,
  COUNCIL_OFFLINE_COPY,
  COUNCIL_ROUND_TIMEOUT_MS,
  COUNCIL_STOPPED_NOTE,
  COUNCIL_TIMEOUT_NOTE,
  councilDisabledCopy,
  councilLedgerRefusalCopy,
  councilNoAnswerColumns,
  councilPromptIssue,
  councilRoomGone,
  councilRoomLedger,
  councilRoomName,
  councilTargets,
  notePendingRoom,
  runCouncil,
  sweepPendingRooms,
  type CouncilColumn,
  type CouncilPendingRoomRefusal,
} from '@/lib/gateway/council';
import { keyValueStorage } from '@/lib/storage/key-value';

const roomLedger = councilRoomLedger(
  keyValueStorage,
  Platform.OS === 'web' ? () => globalThis.localStorage : undefined,
);

/**
 * How long the delete of a transient room may hold a coroutine. The transport's
 * own default is 30 s and this is bookkeeping whose failure is swallowed, so it
 * gets a bound well under that and never touches UI state.
 */
const ROOM_DELETE_TIMEOUT_MS = 8_000;

/** What the round's wall-clock bound rejects with, so a timeout is not a failure. */
const ROUND_TIMED_OUT = Symbol('council round timed out');

/**
 * The room exists but could not be written down as owed. The round is never
 * sent: a room whose delete no future mount knows about is exactly the leak the
 * ledger prevents, so this ends the comparison with a visible refusal instead.
 */
class CouncilRoomNotRecordedError extends Error {
  readonly reason: CouncilPendingRoomRefusal;

  constructor(reason: CouncilPendingRoomRefusal) {
    super(councilLedgerRefusalCopy(reason));
    this.name = 'CouncilRoomNotRecordedError';
    this.reason = reason;
  }
}

/**
 * The most Bots one comparison asks. The same cap `councilTargets` applies:
 * the selection action reads it too, so a picked chip is always a Bot the
 * round will actually ask.
 */
const COUNCIL_MAX_BOTS = 3;

/** Said beside the chips a failed re-read kept, never in place of them. */
const ROSTER_REFRESH_FAILED_COPY = "Couldn't refresh the Bot list";

/**
 * A roster read and the gateway that answered it. Carrying the id with the Bots
 * is what lets the screen tell the previous gateway's answer from this one's,
 * even when it lands after a switch.
 */
type RosterRead = { gatewayId: string; bots: PublicBot[] };

/** No roster at all, with one stable identity so the targets memo can trust it. */
const NO_BOTS: PublicBot[] = [];

/**
 * D7's screen: one prompt, up to three Bots, answers side by side.
 *
 * The app has no per-Bot "ask and await one answer" call, so the send reuses
 * the existing surface that does return text per Bot — the Gate's group round.
 * One transient room is created for the selected Bots, the prompt is sent once
 * (the Gate fans out per Bot server-side), and the returned replies are handed
 * to the shipped `runCouncil`, which keeps the columns in roster order and
 * gives each Bot its own failure.
 *
 * A round is one in-flight thing with three exits: the answers, the operator's
 * Stop, and a wall-clock bound. Whichever fires first settles the screen and
 * invalidates the round, so a late answer from an abandoned round can never
 * repaint over a newer one. The room is bookkeeping, not state: its delete runs
 * after the screen is already idle, and the pending-room ledger makes a room a
 * killed process left behind collectable on the next connected mount.
 */
export default function CouncilScreen() {
  const router = useRouter();
  const { activeGateway, status, hasGroupRooms, botGroups, listBots, openBot, requestSurface } = useGateway();
  // The gateway every Bot on this screen must belong to. No active gateway is an
  // identity of its own: a switch to "none" must not keep the last one's roster.
  const gatewayId = activeGateway?.id ?? '';
  const [rosterRead, setRosterRead] = useState<RosterRead>({ gatewayId: '', bots: [] });
  // The roster read starts empty, so in-flight, refused, and genuinely-empty
  // all used to render the same dead chip box. Three phases keep them apart;
  // only `ready` may claim the roster is empty, and a refused re-read keeps the
  // chips of the read that did land.
  const [rosterState, setRosterState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [rosterError, setRosterError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [prompt, setPrompt] = useState('');
  const [sending, setSending] = useState(false);
  const [columns, setColumns] = useState<CouncilColumn[]>([]);
  const [note, setNote] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  // What this gateway is allowed to draw. A read answered for another gateway
  // stays in state but never appears under this one's name, so a switch drops
  // the previous gateway's Bots — and the picks that went with them — in the
  // very render that made the switch, before any effect could clear them.
  const rosterOwned = rosterRead.gatewayId === gatewayId;
  const roster = rosterOwned ? rosterRead.bots : NO_BOTS;

  // React state cannot guard a handler with side effects: two taps inside one
  // render both read `sending === false`, and the second room was created before
  // the first render landed. This ref is set before the first await, so it is
  // the one thing the second tap can see.
  const inFlightRef = useRef(false);
  // Every round takes a token, and Stop takes the next one. A round that has
  // been stopped is no longer `mine`, which is what stops its late answer, its
  // late failure and its late room from touching the screen.
  const roundRef = useRef(0);
  // The room a running round created, so Stop can delete it without waiting for
  // a request it has already stopped listening to.
  const liveRoomRef = useRef<string | undefined>(undefined);
  // Reads carry a generation: a slow one that lands after a newer read is
  // dropped instead of overwriting it. A gateway switch takes one too, so a
  // read the previous gateway still owes never lands under the new one.
  const rosterGenerationRef = useRef(0);
  // The roster as the last read saw it, tagged with the gateway that answered
  // it, readable from a catch without making `loadRoster` depend on the roster
  // it writes.
  const rosterRef = useRef<RosterRead | null>(null);

  const loadRoster = useCallback(
    async (isLive?: () => boolean): Promise<void> => {
      const generation = rosterGenerationRef.current + 1;
      rosterGenerationRef.current = generation;
      const live = () => generation === rosterGenerationRef.current && (!isLive || isLive());
      // A re-read keeps the chips the operator is looking at: the loading flip
      // is for a read with no roster behind it, and a failure only counts when
      // there is nothing to keep. Chips another gateway answered are not this
      // one's to keep — a failed first read of a new gateway is an honest
      // failure, never A's roster under B's name.
      const lastRead = rosterRef.current;
      const kept = lastRead !== null && lastRead.gatewayId === gatewayId ? lastRead.bots : [];
      setRosterState(kept.length > 0 ? 'ready' : 'loading');
      setRosterError(null);
      try {
        const bots = await listBots();
        if (!live()) return;
        rosterRef.current = { gatewayId, bots };
        setRosterRead({ gatewayId, bots });
        setRosterState('ready');
        // Selection follows the roster: a Bot still on it stays selected, and a
        // Bot the gateway no longer has cannot stay picked for a round.
        const ids = new Set(bots.map((bot) => bot.id));
        setSelected((previous) => previous.filter((botId) => ids.has(botId)));
      } catch (cause) {
        if (!live()) return;
        setRosterError(cause instanceof Error ? cause.message : String(cause));
        // A refusal keeps the last-good roster the way chat does. Only a read
        // with no roster behind it may claim failure — the chips the operator
        // selected from are not wiped by a connection blip.
        if (kept.length === 0) setRosterState('failed');
      }
    },
    [gatewayId, listBots],
  );

  // A gateway switch hands the roster to a new owner. The read the previous
  // gateway still owes is retired here, before anything else could join it, and
  // its Bots and picks are cleared before the new read starts. Deferred a tick
  // because an effect body that writes state trips
  // react-hooks/set-state-in-effect; the `rosterOwned` boundary above already
  // hides the old roster in the switch render itself, so nothing of A's shows
  // in between.
  useEffect(() => {
    rosterGenerationRef.current += 1;
    rosterRef.current = null;
    const timer = setTimeout(() => {
      setRosterRead({ gatewayId, bots: [] });
      setRosterState('loading');
      setRosterError(null);
      setSelected([]);
    }, 0);
    return () => clearTimeout(timer);
  }, [gatewayId]);

  // Deferred one tick so the loading flip is not a setState in the effect
  // body (react-hooks/set-state-in-effect), matching CronSection's mount read.
  useEffect(() => {
    if (status !== 'connected') return undefined;
    let live = true;
    const timer = setTimeout(() => {
      void loadRoster(() => live);
    }, 0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [status, loadRoster]);

  // The room a round owes the Gate a delete for. Its own short bound, its own
  // swallowed failure, and it never touches UI state: the ledger keeps the
  // record until the delete lands, so a failed one is swept rather than lost.
  const dropRoom = useCallback(
    (roomId: string) => {
      void (async () => {
        try {
          await boundedOperation(botGroups.deleteGroup(roomId), ROOM_DELETE_TIMEOUT_MS);
          await clearPendingRoom(roomLedger, roomId);
        } catch (cause) {
          // A room the Gate has already forgotten is the outcome we wanted.
          if (councilRoomGone(cause)) await clearPendingRoom(roomLedger, roomId);
        }
      })();
    },
    [botGroups],
  );

  // Rooms a killed process left behind, swept whenever the screen is connected:
  // on mount, and again after each round. Best-effort throughout — a sweep that
  // cannot run must not stop the screen from comparing Bots.
  useEffect(() => {
    if (status !== 'connected') return undefined;
    const timer = setTimeout(() => {
      void sweepPendingRooms(
        roomLedger,
        (roomId) => botGroups.deleteGroup(roomId),
        Date.now(),
        ROOM_DELETE_TIMEOUT_MS,
      );
    }, 0);
    return () => clearTimeout(timer);
  }, [status, botGroups]);

  // The selected Bots, in the roster's own order, capped like any council.
  const targets = useMemo(() => {
    const selectedIds = new Set(selected);
    return councilTargets(
      roster.filter((bot) => selectedIds.has(bot.id)),
      COUNCIL_MAX_BOTS,
    );
  }, [roster, selected]);

  // The cap is enforced where the selection is made: a chip that looks picked
  // must be a Bot the round asks. Without this the fourth chip stayed
  // highlighted while `councilTargets` silently dropped it. The functional
  // update reads the latest selection, so several toggles inside one tick
  // cannot each see room and overshoot together.
  const toggleBot = (botId: string) => {
    setSelected((previous) => {
      if (previous.includes(botId)) return previous.filter((id) => id !== botId);
      if (previous.length >= COUNCIL_MAX_BOTS) return previous;
      return [...previous, botId];
    });
  };

  const promptIssue = councilPromptIssue(prompt);

  const canCompare =
    status === 'connected' &&
    hasGroupRooms &&
    targets.length >= 2 &&
    prompt.trim().length > 0 &&
    !promptIssue &&
    !sending;

  const handleCompare = async () => {
    const text = prompt.trim();
    const issue = councilPromptIssue(text);
    if (issue) {
      setError(issue);
      return;
    }
    if (!text || targets.length < 2) return;
    // The in-flight ref, not `sending`: state read in this closure is stale by
    // the time a second tap reaches it.
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setSending(true);
    setError(undefined);
    setNote(undefined);
    setColumns([]);
    const token = roundRef.current + 1;
    roundRef.current = token;
    const mine = () => roundRef.current === token;
    let roomId: string | undefined;

    // The bound. It cannot un-send the round, so it settles the screen: the
    // columns that landed stay, the rest say they have no answer, and the round
    // token keeps the late result from touching anything.
    let bound: ReturnType<typeof setTimeout> | undefined;
    const giveUp = new Promise<never>((_, refuse) => {
      bound = setTimeout(() => refuse(ROUND_TIMED_OUT), COUNCIL_ROUND_TIMEOUT_MS);
    });

    try {
      const result = await Promise.race([
        (async () => {
          const room = await botGroups.create({
            name: councilRoomName(),
            memberIds: targets.map((target) => target.botId),
          });
          roomId = room.id;
          liveRoomRef.current = room.id;
          // Written before the send, so a process the OS kills mid-round leaves
          // a note the next mount can act on. A full ledger or a failed read or
          // write means the room is NOT durably recorded: the round must not be
          // sent, because a killed process would leak a room nothing sweeps.
          const admission = await notePendingRoom(roomLedger, room.id);
          if (!admission.recorded) {
            throw new CouncilRoomNotRecordedError(admission.reason);
          }
          // Stopped (or bounded out) while the room was being created: nothing
          // will read this round, so it is never sent and the room goes now
          // rather than waiting to be swept.
          if (!mine()) {
            liveRoomRef.current = undefined;
            dropRoom(room.id);
            return councilNoAnswerColumns(targets);
          }
          const round = await botGroups.send(room.id, { text });
          return runCouncil(text, targets, async (target) => {
            const miss = round.errors?.find((candidate) => candidate.botId === target.botId);
            if (miss) throw new Error(miss.error);
            return round.replies.find((candidate) => candidate.botId === target.botId)?.text ?? '';
          });
        })(),
        giveUp,
      ]);
      if (mine()) setColumns(result);
    } catch (cause) {
      // A stopped round's failure belongs to a round nobody is watching any
      // more, so only the current one may say anything.
      if (mine()) {
        if (cause === ROUND_TIMED_OUT) {
          // Treated as a cancelled round. The race has already unwound, so the
          // late answer cannot reach the columns; this only says what happened.
          setColumns((arrived) => councilNoAnswerColumns(targets, arrived));
          setNote(COUNCIL_TIMEOUT_NOTE);
          // Invalidate the asynchronous create/admission path too: a room that
          // arrives after the bound must be deleted without sending a round.
          roundRef.current += 1;
          setSending(false);
          inFlightRef.current = false;
        } else if (cause instanceof CouncilRoomNotRecordedError) {
          // Nothing was sent: the room could not be admitted durably. The
          // finally below deletes the room, and this says plainly why the
          // comparison did not happen and what the operator can do.
          setColumns([]);
          setError(cause.message);
        } else {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    } finally {
      if (bound) clearTimeout(bound);
      // The screen is settled here, before the room delete starts: a delete
      // that takes the transport's full 30 s must not keep Compare locked.
      if (mine()) {
        setSending(false);
        inFlightRef.current = false;
      }
      const created = roomId;
      if (created && liveRoomRef.current === created) {
        liveRoomRef.current = undefined;
        dropRoom(created);
      }
      void sweepPendingRooms(
        roomLedger,
        (id) => botGroups.deleteGroup(id),
        Date.now(),
        ROOM_DELETE_TIMEOUT_MS,
      );
    }
  };

  /**
   * Stop: settle the screen now, ignore whatever the round still owes, and take
   * the room back while this process still knows its id.
   */
  const handleStop = () => {
    if (!inFlightRef.current) return;
    roundRef.current += 1;
    inFlightRef.current = false;
    setSending(false);
    setNote(COUNCIL_STOPPED_NOTE);
    const room = liveRoomRef.current;
    liveRoomRef.current = undefined;
    if (room) dropRoom(room);
  };

  const handlePressColumn = (column: CouncilColumn) => {
    if (column.state !== 'answered') return;
    void openBot(column.botId)
      .then((opened) => {
        if (!opened) {
          requestSurface({ kind: 'roster' });
          return;
        }
        requestSurface({ kind: 'bot', botId: column.botId });
        router.navigate('/chat');
      })
      .catch(() => requestSurface({ kind: 'roster' }));
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <PageTitle
          title="Council"
          leading={
            <PressableScale
              onPress={() => (router.canGoBack() ? router.back() : router.replace('/home'))}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Back to Gate">
              <Icon
                name={{ ios: 'chevron.left', android: 'arrow_back', web: 'arrow_back' }}
                size={20}
                color="textPrimary"
              />
            </PressableScale>
          }
          status={
            <Text variant="caption" color="secondary">
              Ask up to three Bots the same prompt and compare their answers side by side.
            </Text>
          }
        />

        {!hasGroupRooms ? (
          <Card variant="surface" padding={Spacing.three}>
            <Text variant="body" color="secondary">
              {councilDisabledCopy()}
            </Text>
          </Card>
        ) : (
          <>
            <Card variant="surface" padding={Spacing.three} style={styles.card}>
              <Text variant="micro" color="tertiary">
                {`Bots to compare (${targets.length}/${COUNCIL_MAX_BOTS})`}
              </Text>
              {rosterOwned && rosterState === 'failed' ? (
                <ErrorCard
                  cause={rosterError ?? 'The Bot list could not be read.'}
                  affected="Choosing Bots for this council"
                  next="Retry the read, or reconnect to the gateway."
                  onRetry={() => void loadRoster()}
                />
              ) : status !== 'connected' && roster.length === 0 ? (
                // No gateway and nothing remembered: skeletons here would claim
                // a read this screen has not made and cannot make.
                <EmptyState
                  icon={{ ios: 'antenna.radiowaves.left.and.right.slash', android: 'signal_wifi_off', web: 'wifi_off' }}
                  title="Not connected to a gateway"
                  description={COUNCIL_OFFLINE_COPY}
                />
              ) : !rosterOwned || (rosterState === 'loading' && roster.length === 0) ? (
                // A new gateway's roster is loading even before its read starts:
                // the previous gateway's phase and chips are not this one's to
                // draw, so the slot claims the read it is about to make.
                <View style={styles.chips} accessibilityLabel="Loading bots">
                  <Skeleton width={96} height={34} radius={Radius.full} />
                  <Skeleton width={78} height={34} radius={Radius.full} />
                  <Skeleton width={110} height={34} radius={Radius.full} />
                </View>
              ) : rosterState === 'ready' && roster.length === 0 ? (
                <EmptyState
                  icon={{ ios: 'person.2', android: 'group', web: 'group' }}
                  title="No bots on this gateway"
                  description="A council compares answers from Bots on this gateway — none are available yet."
                />
              ) : (
                <View style={styles.chips}>
                  {roster.map((bot) => {
                    const picked = selected.includes(bot.id);
                    // At the cap a Bot that is not already picked cannot join
                    // the round, so its chip says so instead of lighting up and
                    // being dropped. Picked chips stay pressable: a slot is
                    // freed by deselecting one.
                    return (
                      <Chip
                        key={bot.id}
                        label={bot.displayName || bot.id}
                        selected={picked}
                        disabled={!picked && selected.length >= COUNCIL_MAX_BOTS}
                        onPress={() => toggleBot(bot.id)}
                      />
                    );
                  })}
                </View>
              )}
              {rosterError && roster.length > 0 ? (
                // The chips above are the last-good read; this says the refresh
                // behind them failed and offers the way back.
                <View style={styles.rosterNote}>
                  <Text variant="caption" color="secondary">
                    {ROSTER_REFRESH_FAILED_COPY}
                  </Text>
                  <Button label="Retry" variant="ghost" size="sm" onPress={() => void loadRoster()} />
                </View>
              ) : null}
              <TextField
                value={prompt}
                onChangeText={setPrompt}
                placeholder="One prompt for every Bot"
                multiline
                accessibilityLabel="Council prompt"
                validationState={error || promptIssue ? 'invalid' : 'default'}
              />
              <Button
                label={sending ? 'Stop' : 'Compare'}
                variant={sending ? 'destructive' : 'primary'}
                onPress={() => void (sending ? handleStop() : handleCompare())}
                disabled={!(sending || canCompare)}
              />
              {sending ? (
                <Text variant="caption" color="secondary">
                  Asking the selected Bots…
                </Text>
              ) : note ? (
                <Text variant="caption" color="secondary">
                  {note}
                </Text>
              ) : null}
              {error ? (
                <ErrorCard
                  cause={error}
                  affected="This comparison"
                  next={
                    promptIssue
                      ? 'Drop the leading slash, then compare again.'
                      : 'Retry, or adjust the prompt and compare again.'
                  }
                  onRetry={() => void handleCompare()}
                />
              ) : promptIssue ? (
                <Text variant="caption" color="secondary">
                  {promptIssue}
                </Text>
              ) : null}
            </Card>

            {columns.length > 0 ? (
              <CouncilCompareView columns={columns} onPressColumn={handlePressColumn} />
            ) : null}
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: Spacing.four,
    gap: Spacing.four,
  },
  card: {
    gap: Spacing.three,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  rosterNote: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
});
