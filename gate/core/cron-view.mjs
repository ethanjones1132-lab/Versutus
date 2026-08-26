/**
 * Cron transparency: turning what Hermes holds into what an operator can read.
 *
 * Hermes carries 36 fields per job plus a `latest_execution`, and writes every
 * run to a session named `cron_<jobId>_<yyyymmdd>_<hhmmss>`. That naming is the
 * ONLY link between a job and its transcripts — and it is a host convention,
 * not a domain fact, so it is decoded here rather than in the phone. The app
 * asks the Gate for cron; it never learns how Hermes spells a session id.
 *
 * Everything degrades instead of throwing: an older gateway that reports none
 * of these fields still yields a usable row, with absent values reading as
 * unknown rather than as confident falsehoods.
 */

/** `cron_<jobId>_<date>_<time>` → its parts, or null when it is not a run. */
export function parseCronSessionId(sessionId) {
  const match = /^cron_([0-9a-zA-Z]+)_(\d{8}_\d{6})$/.exec(String(sessionId ?? ''));
  if (!match) return null;
  return { jobId: match[1], at: match[2] };
}

/**
 * The Bot a routine belongs to. Versutus namespaces a Bot's jobs
 * `[bot:<name>] <title>` (ADR 0005 vocabulary); anything else belongs to the
 * gateway itself and gets a null owner rather than an invented one.
 */
export function parseRoutineOwner(name) {
  const text = String(name ?? '');
  const match = /^\[bot:([^\]]+)\]\s*(.*)$/.exec(text);
  if (!match) return { botId: null, title: text };
  return { botId: match[1], title: match[2].trim() };
}

/** One past or in-flight run, from the session that recorded it. */
export function toCronRunView(session) {
  const parsed = parseCronSessionId(session?.id);
  if (!parsed) return null;
  const finishedAt = session.ended_at ?? null;
  return {
    id: session.id,
    jobId: parsed.jobId,
    at: parsed.at,
    startedAt: session.started_at ?? null,
    finishedAt,
    // A cron session with no end is still going. The job's own
    // latest_execution is authoritative for the *newest* run; this keeps
    // history rows honest without a second lookup.
    status: finishedAt ? 'completed' : 'running',
    turnCount: session.message_count ?? 0,
    error: session.end_reason === 'error' ? (session.end_reason ?? null) : null,
  };
}

/** Every run belonging to one job, newest first. */
export function runsForJob(jobId, sessions) {
  const wanted = String(jobId ?? '');
  if (!wanted) return [];
  return (sessions ?? [])
    .map(toCronRunView)
    .filter((run) => run && run.jobId === wanted)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/**
 * Job ids that have run history but no surviving job — a deleted or renamed
 * cron still leaves readable transcripts, and hiding them would be a smaller
 * truth than the operator already has.
 */
export function orphanJobIds(sessions, jobs) {
  const live = new Set((jobs ?? []).map((job) => String(job?.id)));
  const seen = new Set();
  for (const session of sessions ?? []) {
    const parsed = parseCronSessionId(session?.id);
    if (parsed && !live.has(parsed.jobId)) seen.add(parsed.jobId);
  }
  return [...seen];
}

const asList = (value) => (Array.isArray(value) ? value : []);
const orNull = (value) => (value === undefined || value === '' ? null : value);

/**
 * The curated view, with the untouched record attached.
 *
 * Curated leads because 36 raw fields answer no question quickly; `raw` rides
 * along so "show raw record" can never become a curated lie. The prompt itself
 * travels in full — it is the whole point of transparency — with its length
 * reported so a client can collapse it without measuring first.
 */
export function toCronJobView(job) {
  if (!job || !job.id) return null;
  const { botId, title } = parseRoutineOwner(job.name);
  const execution = job.latest_execution ?? null;
  const prompt = typeof job.prompt === 'string' ? job.prompt : '';
  return {
    id: String(job.id),
    title,
    name: orNull(job.name),
    botId,
    schedule: orNull(job.schedule),
    scheduleDisplay: orNull(job.schedule_display),
    nextRunAt: orNull(job.next_run_at),
    lastRunAt: orNull(job.last_run_at),
    lastStatus: orNull(job.last_status),
    lastError: orNull(job.last_error),
    lastDeliveryError: orNull(job.last_delivery_error),
    failureStreak: job.failure_streak ?? 0,
    state: orNull(job.state),
    paused: job.enabled === false || Boolean(job.paused_at),
    pausedReason: orNull(job.paused_reason),
    cooldownUntil: orNull(job.cooldown_until),
    cooldownReason: orNull(job.cooldown_reason),
    model: orNull(job.model),
    provider: orNull(job.provider),
    toolsets: asList(job.enabled_toolsets),
    workdir: orNull(job.workdir),
    deliver: orNull(job.deliver),
    origin: orNull(job.origin),
    prompt,
    promptLength: prompt.length,
    running: execution?.status === 'running',
    latestExecution: execution,
    raw: job,
  };
}

/** A transcript turn, in the shape the chat surfaces already parse. */
export function toCronTurn(message) {
  if (!message) return null;
  const content = Array.isArray(message.content)
    ? message.content.filter((part) => part?.type === 'text').map((part) => part.text).join('')
    : typeof message.content === 'string'
      ? message.content
      : '';
  const toolName = Array.isArray(message.tool_calls) && message.tool_calls.length > 0
    ? (message.tool_calls[0]?.name ?? message.tool_calls[0]?.function?.name ?? null)
    : null;
  return {
    id: String(message.id ?? ''),
    role: message.role ?? 'assistant',
    text: content,
    at: message.timestamp ?? null,
    toolName,
  };
}
