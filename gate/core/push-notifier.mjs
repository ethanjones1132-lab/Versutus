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

function localMinutes(timeZone) {
  if (typeof timeZone !== 'string' || timeZone.length === 0) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      hourCycle: 'h23',
      minute: '2-digit',
      timeZone,
      hour: '2-digit',
    }).formatToParts(new Date());
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

function allowedForBot(row, botId) {
  const allowed = Array.isArray(row.botIds) ? row.botIds : [];
  if (allowed.length === 0) return true;
  return typeof botId === 'string' && allowed.includes(botId);
}

function truncateText(text) {
  return typeof text === 'string' && text.length > 80 ? `${text.slice(0, 80)}…` : (typeof text === 'string' ? text : '');
}

function classifiedEvent(event) {
  const trigger = event?.trigger;
  const cron = trigger === 'final-response' ? parseCronSessionId(event?.sessionId) : null;
  if (cron) {
    return {
      trigger: 'routine',
      id: cron.jobId,
      data: {
        kind: 'routine',
        jobId: cron.jobId,
        ...(nonEmptyString(event.botId) ? { botId: event.botId } : {}),
      },
    };
  }

  if (trigger === 'final-response') {
    const sessionId = nonEmptyString(event?.sessionId);
    return sessionId ? {
      trigger,
      id: sessionId,
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
    return {
      to: row.expoPushToken,
      title: state === 'failed' || state === 'error'
        ? `${bot ?? 'Versutus'} hit an error`
        : `${bot ?? 'Versutus'} finished a run`,
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

export function createPushNotifier({ tokens, send }) {
  if (!tokens || typeof tokens.listEnabled !== 'function' || typeof tokens.removeByToken !== 'function') {
    throw new Error('tokens must provide listEnabled() and removeByToken()');
  }
  if (typeof send !== 'function') throw new Error('send must be a function');

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
      if (isQuiet(row)) continue;
      const key = `${classified.trigger}:${classified.id}:${event?.state ?? ''}`;
      if (!remember(key)) continue;
      messages.push(messageFor(classified, event, row));
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
