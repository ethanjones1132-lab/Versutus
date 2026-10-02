import { parseCronSessionId } from './cron-view.mjs';

const DEDUPE_LIMIT = 1000;

/**
 * The category the phone registers for a bot-message notice, named by
 * `BOT_MESSAGE_CATEGORY_ID` in `src/lib/notifications/categories.ts` — the one
 * poster there is a TypeScript module the Gate cannot import, so the string is
 * repeated here and pinned against that file by
 * `__tests__/push-notifier-category.test.mjs`.
 *
 * Android attaches action rows only when the notification content carries a
 * category, and for a push that content field is the FCM data key `categoryId`
 * — a documented field of the Expo push message ("Message request format",
 * https://docs.expo.dev/push-notifications/sending-notifications/). Without it
 * no relayed notice ever shows the Reply button the app registered for it.
 */
const BOT_MESSAGE_CATEGORY_ID = 'botmessage';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function validQuietHours(value) {
  return isRecord(value)
    && Number.isInteger(value.startMinutes)
    && Number.isInteger(value.endMinutes)
    && value.startMinutes >= 0
    && value.startMinutes < 24 * 60
    && value.endMinutes >= 0
    && value.endMinutes < 24 * 60;
}

function localMinutes(timeZone, now) {
  if (typeof timeZone !== 'string' || timeZone.length === 0) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      hourCycle: 'h23',
      minute: '2-digit',
      timeZone,
      hour: '2-digit',
    }).formatToParts(now ?? new Date());
    const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '');
    const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '');
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return (hour % 24) * 60 + minute;
  } catch {
    return null;
  }
}

function isQuiet(row, nowMinutes = localMinutes(row.timezone)) {
  if (!validQuietHours(row.quietHours)) return false;
  if (nowMinutes === null) return false;
  const { startMinutes, endMinutes } = row.quietHours;
  if (startMinutes === endMinutes) return false;
  if (startMinutes < endMinutes) return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
}

// Quiet hours exist so the phone does not speak overnight. An approval, though,
// blocks a live run waiting on a human: when the device opted in, the one kind
// that needs the operator pierces the window rather than waiting until morning.
function quietExemptsEvent(row, classified) {
  if (row.quietHoursAllowApprovals !== true) return false;
  return classified?.data?.kind === 'approval';
}

function allowedForBot(row, botId) {
  const allowed = Array.isArray(row.botIds) ? row.botIds : [];
  if (allowed.length === 0) return true;
  // The filter chooses which Bots may speak. An event that names no Bot — an
  // approval card, a run verdict — is the Gate's own, so the filter never
  // silences it.
  if (typeof botId !== 'string' || botId.length === 0) return true;
  return allowed.includes(botId);
}

function truncateText(text) {
  return typeof text === 'string' && text.length > 80 ? `${text.slice(0, 80)}…` : (typeof text === 'string' ? text : '');
}

function classifiedEvent(event) {
  const trigger = event?.trigger;
  const cron = trigger === 'final-response' ? parseCronSessionId(event?.sessionId) : null;
  if (trigger === 'final-response' && cron) {
    // Each scheduled execution records its own timestamped Session, so the
    // Session id is already per-execution: dedupe on it, never on the job id
    // a daily Routine would then lose after its first run. A routine names
    // its Bot on the tap — an execution that carried none is unaddressable
    // and must not populate the tray with a payload nothing can open.
    const botId = nonEmptyString(event?.botId);
    if (!botId) return null;
    return {
      trigger: 'routine',
      id: `${cron.jobId}@${event.sessionId}`,
      data: {
        kind: 'routine',
        jobId: cron.jobId,
        botId,
      },
    };
  }

  if (trigger === 'final-response') {
    const sessionId = nonEmptyString(event?.sessionId);
    // A chat Session earns one notification per turn, and the Gate replays a
    // completed turn's event verbatim. A per-turn identity from the emission
    // seam lets a replay collapse while the Session's next turn — even one
    // with the same final text — still notifies. An event without a turn id
    // (an older emitter, a test fixture) falls back to text.
    const turn = nonEmptyString(event?.turnId) ?? (typeof event.text === 'string' ? event.text : '');
    return sessionId ? {
      trigger,
      id: `${sessionId}@${turn}`,
      data: {
        kind: 'reply',
        sessionId,
        ...(nonEmptyString(event.botId) ? { botId: event.botId } : {}),
      },
    } : null;
  }

  if (trigger === 'run') {
    const runId = nonEmptyString(event?.runId);
    return runId ? { trigger, id: runId, data: { kind: 'run', runId } } : null;
  }

  if (trigger === 'approval') {
    const runId = nonEmptyString(event?.runId);
    return runId ? { trigger, id: runId, data: { kind: 'approval', runId } } : null;
  }

  if (trigger === 'routine') {
    const jobId = nonEmptyString(event?.jobId);
    const botId = nonEmptyString(event?.botId);
    // The tap router opens a routine in its Bot's Chat — an event that names
    // no Bot is unaddressable, so the relay withholds it like the local path.
    if (!jobId || !botId) return null;
    return {
      trigger,
      id: jobId,
      data: {
        kind: 'routine',
        jobId,
        botId,
      },
    };
  }

  return null;
}

function messageFor(classified, event, row) {
  const richBody = row.richBody === true;
  const body = richBody ? truncateText(event.text) : '';
  const bot = nonEmptyString(event.botId);
  const state = event.state;

  if (classified.data.kind === 'reply') {
    return {
      to: row.expoPushToken,
      title: `${bot ?? 'Versutus'} finished a reply`,
      body,
      data: classified.data,
      channelId: 'model-replies',
      sound: 'default',
      // Only a reply that names a Bot carries a category, and that is the whole
      // point of one: the Reply action posts into the Bot's chat, and
      // bot-reply.ts's `botReplyFromResponse` refuses a payload without both
      // `botId` and `sessionId`. A turn posted with no Bot (server.mjs makes
      // `botId` conditional on `?bot=`/`body.bot`) would therefore show a
      // button whose tap sends nothing. A run, approval or routine notice
      // names no destination an action could serve, so they carry none either.
      ...(nonEmptyString(classified.data.botId) ? { categoryId: BOT_MESSAGE_CATEGORY_ID } : {}),
    };
  }
  if (classified.data.kind === 'run') {
    const title = state === 'failed' || state === 'error'
      ? `${bot ?? 'Versutus'} hit an error`
      : state === 'cancelled'
        ? `${bot ?? 'Versutus'} cancelled a run`
        : `${bot ?? 'Versutus'} finished a run`;
    return {
      to: row.expoPushToken,
      title,
      body,
      data: classified.data,
      channelId: 'model-replies',
      sound: 'default',
    };
  }
  if (classified.data.kind === 'approval') {
    return {
      to: row.expoPushToken,
      title: 'Approval required',
      body,
      data: classified.data,
      channelId: 'approvals',
      sound: 'default',
      priority: 'high',
    };
  }
  return {
    to: row.expoPushToken,
    title: `${bot ?? 'A routine'} finished`,
    body,
    data: classified.data,
    channelId: 'routine-results',
    sound: 'default',
  };
}

/**
 * The widget's companion: a data-only message the app's background task reads
 * to redraw the card while the app is closed. Sent only to devices that asked
 * for it, and never a tray notice — no title, no body.
 *
 * `snapshot` is the Gate's live state (or a function returning it):
 * `{ work, approvalsPending }`. Absent providers keep the historical defaults,
 * so a notifier constructed without one still reports an idle Gate with
 * nothing awaiting triage.
 */
function resolveSnapshot(snapshot) {
  try {
    const value = typeof snapshot === 'function' ? snapshot() : snapshot;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** The word the card leads with when the Gate — not the phone — wrote it. */
const GATE_STATUS_WORD = 'Updated';

/**
 * The companion claims nothing about the phone's link to the Gate: the Gate has
 * no reading of it — it reaches Expo over the internet while the phone may not
 * reach the Gate at all — so it writes neither `connected` nor a connection
 * word. Said here because the alternative — a card freshly stamped
 * "Connected" by a push the phone cannot check — is the lie this companion used
 * to tell, however far the Gate could reach Expo.
 *
 * `WidgetPayload.parse` still requires `connected`, so on today's phone this
 * write is refused and the card keeps the last snapshot the app itself wrote.
 * That half is the phone's to fix (the headless push task must merge the pushed
 * fields into the stored snapshot and supply `connected` itself, and `status`
 * must then agree with it), and until it does the companion is the cost of
 * telling the truth: one data-only push per opted-in device, no card write.
 */
function widgetCompanion(row, event, snapshot) {
  if (row.widgetUpdates !== true) return null;
  const snap = resolveSnapshot(snapshot);
  const approvalsPending = Number.isInteger(snap?.approvalsPending) && snap.approvalsPending >= 0
    ? snap.approvalsPending
    : 0;
  // The widget sits on the home screen, visible without unlocking the phone:
  // the newest result rides along only when the device opted into rich bodies.
  const widget = {
    v: 2,
    status: GATE_STATUS_WORD,
    work: nonEmptyString(snap?.work) ?? 'No runs in flight',
    ...(nonEmptyString(event?.text) && row.richBody === true ? { result: truncateText(event.text) } : {}),
    approvalsPending,
    writtenAt: Date.now(),
  };
  return {
    to: row.expoPushToken,
    data: { kind: 'widget', widget },
    priority: 'normal',
  };
}

/**
 * The Gate's live state for the widget companion: how many runs are in flight
 * and how many approval cards await triage. Pure, so the wording is unit-tested
 * without booting a Gate.
 *
 * No `connected` key: what the Gate knows is its own state, never the phone's
 * link to it (see widgetCompanion).
 */
export function widgetSnapshot({ busyRuns = 0, approvalsPending = 0 } = {}) {
  const runs = Number.isInteger(busyRuns) && busyRuns > 0 ? busyRuns : 0;
  const pending = Number.isInteger(approvalsPending) && approvalsPending >= 0 ? approvalsPending : 0;
  return {
    work: runs === 0 ? 'No runs in flight' : `${runs} run${runs === 1 ? '' : 's'} in flight`,
    approvalsPending: pending,
  };
}

export function createPushNotifier({ tokens, send, collectReceipts = null, snapshot = null, now, receiptDelayMs }) {
  if (!tokens || typeof tokens.listEnabled !== 'function' || typeof tokens.removeByToken !== 'function') {
    throw new Error('tokens must provide listEnabled() and removeByToken()');
  }
  if (typeof send !== 'function') throw new Error('send must be a function');
  // Injectable clock, so tests pin the minute of day; production reads the wall clock.
  const nowSource = typeof now === 'function' ? now : () => new Date();
  // Expo needs ~15 minutes before receipts exist; tests inject a short delay.
  const receiptDelay = typeof receiptDelayMs === 'number' ? receiptDelayMs : 15 * 60 * 1000;

  const seen = new Set();

  function remember(key) {
    if (seen.has(key)) return false;
    if (seen.size >= DEDUPE_LIMIT) seen.delete(seen.values().next().value);
    seen.add(key);
    return true;
  }

  // One deferred receipt collection per batch, scheduled after a successful
  // send: Expo produces receipts asynchronously, so polling inline would find
  // nothing. Dead tokens found by the receipts prune through the same
  // removeByToken path the ticket-level dead tokens already use. The send
  // result's ticket-to-token map must travel with the ticket ids — a receipt
  // names a ticket id, but the store prunes by push token.
  function scheduleReceiptCollection(result) {
    if (typeof collectReceipts !== 'function') return;
    const ticketIds = (Array.isArray(result?.tickets) ? result.tickets : [])
      .filter((ticket) => ticket?.status === 'ok' && typeof ticket.id === 'string')
      .map((ticket) => ticket.id);
    if (ticketIds.length === 0) return;
    const ticketTokens = result?.ticketTokens && typeof result.ticketTokens === 'object' ? result.ticketTokens : {};
    const timer = setTimeout(() => {
      Promise.resolve()
        .then(() => collectReceipts(ticketIds, ticketTokens))
        .then((receiptResult) => {
          if (receiptResult?.ok !== true) return;
          const deadTokens = Array.isArray(receiptResult.deadTokens) ? receiptResult.deadTokens : [];
          return Promise.all(deadTokens.map((token) => tokens.removeByToken(token)));
        })
        .catch((error) => {
          console.warn('Deferred push receipt collection failed:', error?.message ?? error);
        });
    }, receiptDelay);
    // A pending receipt collection must never hold the process open.
    timer.unref?.();
  }

  async function notify(event) {
    const classified = classifiedEvent(event);
    if (!classified) return { ok: true, sent: 0 };

    // The dedupe must answer "did I already speak for THIS event?", not "did
    // this row already speak?". One event produces one notice per eligible
    // device, so the key is claimed once before the device loop — claiming it
    // inside the loop would let the first recipient consume the slot and skip
    // every later device.
    const key = `${classified.trigger}:${classified.id}:${event?.state ?? ''}`;
    if (!remember(key)) return { ok: true, sent: 0 };

    const rows = await tokens.listEnabled();
    const messages = [];
    let addressed = false;
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!isRecord(row) || row.enabled !== true || typeof row.expoPushToken !== 'string' || !row.expoPushToken) continue;
      if (!allowedForBot(row, event?.botId)) continue;
      addressed = true;
      if (isQuiet(row, localMinutes(row.timezone, nowSource())) && !quietExemptsEvent(row, classified)) continue;
      messages.push(messageFor(classified, event, row));
      const companion = widgetCompanion(row, event, snapshot);
      if (companion) messages.push(companion);
    }

    if (messages.length === 0) {
      // The event has not been spoken for, so the slot it holds must not stay
      // held. A roster that comes up short — a store that is missing or still
      // half-written (push-tokens.mjs reads an unreadable file as no devices),
      // a row momentarily not enabled — would otherwise retire the one notice
      // that exists to reach a phone which is not connected, silently and for the
      // life of the process. Quiet hours are not that: the device is there and
      // policy chose not to speak, so the claim stands and a replay is still a
      // replay.
      if (!addressed) seen.delete(key);
      return { ok: true, sent: 0 };
    }
    const result = await send(messages);
    if (result?.ok !== true) {
      // A transport failure delivered nothing: forget the slot so a later
      // notify can retry the same event. A batch that reached Expo — even
      // with dead tokens to prune — keeps its claim.
      seen.delete(key);
      return result;
    }
    const deadTokens = Array.isArray(result?.deadTokens) ? result.deadTokens : [];
    await Promise.all(deadTokens.map((token) => tokens.removeByToken(token)));
    scheduleReceiptCollection(result);
    return result;
  }

  return {
    notify,
    forget(key) {
      seen.delete(key);
    },
  };
}
