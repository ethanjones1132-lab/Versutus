import { parseCronSessionId } from './cron-view.mjs';

const DEDUPE_LIMIT = 1000;

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
    // a daily Routine would then lose after its first run.
    return {
      trigger: 'routine',
      id: `${cron.jobId}@${event.sessionId}`,
      data: {
        kind: 'routine',
        jobId: cron.jobId,
        ...(nonEmptyString(event.botId) ? { botId: event.botId } : {}),
      },
    };
  }

  if (trigger === 'final-response') {
    const sessionId = nonEmptyString(event?.sessionId);
    // A chat Session earns one notification per turn, and the Gate replays a
    // completed turn's event verbatim, so the turn's own final text is the
    // smallest key that lets a replay collapse while the Session's next turn
    // still notifies.
    return sessionId ? {
      trigger,
      id: `${sessionId}@${typeof event.text === 'string' ? event.text : ''}`,
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
    return jobId ? {
      trigger,
      id: jobId,
      data: {
        kind: 'routine',
        jobId,
        ...(nonEmptyString(event.botId) ? { botId: event.botId } : {}),
      },
    } : null;
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
 * `{ connected, work, approvalsPending }`. Absent providers keep the
 * historical defaults so a notifier constructed without one still reports a
 * connected, idle Gate with nothing awaiting triage.
 */
function resolveSnapshot(snapshot) {
  try {
    const value = typeof snapshot === 'function' ? snapshot() : snapshot;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function widgetCompanion(row, event, snapshot) {
  if (row.widgetUpdates !== true) return null;
  const snap = resolveSnapshot(snapshot);
  const connected = snap?.connected !== false;
  const approvalsPending = Number.isInteger(snap?.approvalsPending) && snap.approvalsPending >= 0
    ? snap.approvalsPending
    : 0;
  // The widget sits on the home screen, visible without unlocking the phone:
  // the newest result rides along only when the device opted into rich bodies.
  const widget = {
    v: 2,
    status: connected ? 'Connected' : 'Disconnected',
    connected,
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
 * The Gate's live state for the widget companion: how many environments are
 * mid-run and how many approval cards await triage. Pure, so the wording is
 * unit-tested without booting a Gate.
 */
export function widgetSnapshot({ connected = true, busyRuns = 0, approvalsPending = 0 } = {}) {
  const runs = Number.isInteger(busyRuns) && busyRuns > 0 ? busyRuns : 0;
  const pending = Number.isInteger(approvalsPending) && approvalsPending >= 0 ? approvalsPending : 0;
  return {
    connected,
    work: runs === 0 ? 'No runs in flight' : `${runs} run${runs === 1 ? '' : 's'} in flight`,
    approvalsPending: pending,
  };
}

export function createPushNotifier({ tokens, send, snapshot = null, now }) {
  if (!tokens || typeof tokens.listEnabled !== 'function' || typeof tokens.removeByToken !== 'function') {
    throw new Error('tokens must provide listEnabled() and removeByToken()');
  }
  if (typeof send !== 'function') throw new Error('send must be a function');
  // Injectable clock, so tests pin the minute of day; production reads the wall clock.
  const nowSource = typeof now === 'function' ? now : () => new Date();

  const seen = new Set();

  function remember(key) {
    if (seen.has(key)) return false;
    if (seen.size >= DEDUPE_LIMIT) seen.delete(seen.values().next().value);
    seen.add(key);
    return true;
  }

  async function notify(event) {
    const classified = classifiedEvent(event);
    if (!classified) return { ok: true, sent: 0 };

    const rows = await tokens.listEnabled();
    const messages = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!isRecord(row) || row.enabled !== true || typeof row.expoPushToken !== 'string' || !row.expoPushToken) continue;
      if (!allowedForBot(row, event?.botId)) continue;
      if (isQuiet(row, localMinutes(row.timezone, nowSource())) && !quietExemptsEvent(row, classified)) continue;
      // The dedupe must answer "did I already speak for THIS turn?", not
      // "did this Session ever produce a reply?". A Session earns one
      // notification per completed turn, and a cron job one per scheduled
      // execution (each execution carries its own timestamped Session).
      // Only retries of the literally-same delivery collapse onto one key —
      // as does an unchanged `remember(key)` replay.
      const key = `${classified.trigger}:${classified.id}:${event?.state ?? ''}`;
      if (!remember(key)) continue;
      messages.push(messageFor(classified, event, row));
      const companion = widgetCompanion(row, event, snapshot);
      if (companion) messages.push(companion);
    }

    if (messages.length === 0) return { ok: true, sent: 0 };
    const result = await send(messages);
    const deadTokens = Array.isArray(result?.deadTokens) ? result.deadTokens : [];
    await Promise.all(deadTokens.map((token) => tokens.removeByToken(token)));
    return result;
  }

  return {
    notify,
    forget(key) {
      seen.delete(key);
    },
  };
}
