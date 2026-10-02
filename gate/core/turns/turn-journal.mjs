import { randomBytes } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { readdir as nodeReaddir, rm as nodeRm } from 'node:fs/promises';
import { join } from 'node:path';

// Durable turns (docs/design/durable-turns.md 3.2). One JSONL file per turn:
//
//   <dir>/<safe callerId>/<safe turnId>.jsonl
//
//   line 1     the meta record, rewritten atomically whenever the status changes
//   line 2..n  one event per SSE frame, appended in order
//
// beside it, `<safe turnId>.text`: the assembled reply, written once when the
// turn ends. It is kept separately so the per-turn frame cap can drop frames
// without ever costing the answer.
//
// A turn belongs to the Gate, not to the HTTP request that started it, so every
// frame is written here as it happens. Any subscriber - the original request, a
// later request after a reconnect, another device - reads the journal from a
// sequence number and then follows it live. That is the whole durability story:
// the phone closing is a subscriber going away, never a turn ending.

const DEFAULT_MAX_EVENT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_TEXT_BYTES = 256 * 1024;
const DEFAULT_MAX_TURNS = 300;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_FLUSH_MS = 250;
// How often retention may sweep, at most. The sweep reads every turn's meta
// line, so it is a background task and never something a chat turn waits on.
const DEFAULT_PRUNE_INTERVAL_MS = 60 * 1000;
// A meta record is one line; a bounded read gets it without pulling a turn's
// whole frame log (up to the cap) into memory to look at the first 300 bytes.
const META_LINE_BYTES = 8 * 1024;
// What one event costs in the file beyond its payload: `{"seq":n,"t":n,"data":""}`
// and a newline. An estimate is enough - the cap bounds growth, it is not a
// quota.
const EVENT_ENVELOPE_BYTES = 48;

// Windows keeps a just-written file briefly locked, so the rename over the
// target can fail with EPERM/EBUSY (the same hazard atomic-file.mjs retries
// around). This rewrite is synchronous - a turn's status must be on disk before
// the request that ended it answers - so the retry is a synchronous one, and
// it is bounded well under a second.
const RENAME_ATTEMPTS = 10;
const RENAME_RETRY_MS = 10;
const RENAME_PAUSE = new Int32Array(new SharedArrayBuffer(4));

/**
 * Every filesystem call the journal makes goes through one object, so a test can
 * count the reads a single turn does. This is what it is in production: the two
 * builtin modules, unchanged.
 */
const DEFAULT_FS = { ...nodeFs, readdir: nodeReaddir, rm: nodeRm };

function renameWithRetry(io, from, to) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        io.renameSync(from, to);
        return;
      } catch (error) {
        const retryable = error?.code === 'EPERM' || error?.code === 'EBUSY';
        if (!retryable || attempt >= RENAME_ATTEMPTS - 1) throw error;
        Atomics.wait(RENAME_PAUSE, 0, 0, RENAME_RETRY_MS);
      }
    }
  }

/**
 * Caller ids and turn ids end up as path segments, and a turn id arrives from
 * any API caller, so every segment is reduced to a safe charset before it
 * touches the disk. Same reduction as the run archive and the run streams.
 */
function safeSegment(value, fallback = 'turn') {
  const cleaned = String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '_');
  // A segment made only of dots survives the charset reduction (`..` is valid
  // in it) and would name a parent directory, so leading dots are dropped.
  const trimmed = cleaned.replace(/^\.+/, '').slice(0, 120);
  return trimmed.length > 0 ? trimmed : fallback;
}

/** The assistant text one OpenAI-shaped frame carries, or '' for every other frame. */
function deltaText(data) {
  if (typeof data !== 'string' || !data.startsWith('{')) return '';
  try {
    const content = JSON.parse(data)?.choices?.[0]?.delta?.content;
    return typeof content === 'string' ? content : '';
  } catch {
    // An opaque frame (tool calls, telemetry, an upstream error) carries no
    // reply text and is never half-parsed into one.
    return '';
  }
}

function isDeltaFrame(data) {
  return deltaText(data).length > 0;
}

/** What one event costs in the file, envelope included. */
function eventBytes(event) {
  return Buffer.byteLength(event.data) + EVENT_ENVELOPE_BYTES;
}

/**
 * Two requests can both find a turn id unused and then both start one. The
 * second `begin` must not take over the first turn's file and live entry - which
 * would leave the first turn's `finish` evicting the second's - so it is refused
 * by name, and the caller answers that request as a replay of the turn already
 * running (design 3.3: a retry is never a second turn).
 */
export class TurnExistsError extends Error {
  constructor(turnId) {
    super(`turn "${turnId}" is already running`);
    this.name = 'TurnExistsError';
    this.code = 'turn_exists';
    this.turnId = turnId;
  }
}

/**
 * One turn's journal: create it, append frames to it, finish it, and let
 * subscribers replay it.
 *
 * `now` is injected so a test can drive retention and the event timestamps
 * without waiting for a week or a millisecond. `log` receives one line per
 * persistence fault; nothing here ever throws into a request - a journal that
 * cannot be written must not take a reply down with it.
 */
export function createTurnJournal({
  dir,
  now = Date.now,
  maxEventBytes = DEFAULT_MAX_EVENT_BYTES,
  maxTextBytes = DEFAULT_MAX_TEXT_BYTES,
  maxTurns = DEFAULT_MAX_TURNS,
  retentionMs = DEFAULT_RETENTION_MS,
  flushMs = DEFAULT_FLUSH_MS,
  pruneIntervalMs = DEFAULT_PRUNE_INTERVAL_MS,
  fs = null,
  log = () => {},
} = {}) {
  const io = fs ? { ...DEFAULT_FS, ...fs } : DEFAULT_FS;
  /** Turns THIS process is running, keyed by caller + turn id. */
  const live = new Map();
  /**
   * Every turn this journal knows about, keyed caller + turn id: what is on
   * disk, read once from the meta lines, plus everything begun since.
   *
   * Retention is enforced from this rather than by walking the directory. A
   * sweep that readdir'd every caller's directory and parsed every line of every
   * turn file to learn `status` did hundreds of MB of blocking reads on the
   * Gate's one event loop, twice per chat turn - which is a request stall, not a
   * background task.
   */
  const index = new Map();
  /** The one startup scan, or null before something needs it. */
  let indexBuilt = null;
  /** The prune in flight, the one wanted next, and the sweep's own clock. */
  let pruneTask = null;
  let pruneInterval = null;
  let prunePending = false;
  let lastPruneAt = 0;
  let closed = false;

  const callerDir = (callerId) => join(dir, safeSegment(callerId, 'anonymous'));
  const fileFor = (callerId, turnId) => join(callerDir(callerId), `${safeSegment(turnId)}.jsonl`);
  // The assembled reply lives beside the frame log rather than inside it, so the
  // per-turn event cap can drop frames without ever costing the answer (design
  // 3.2: "the assembled final text is kept separately").
  const textFileFor = (path) => path.replace(/\.jsonl$/, '.text');
  const turnKey = (callerId, turnId) => `${callerId}\u0000${turnId}`;

  /** A subscriber's own fault must not become the turn's. */
  function safeCall(fn, argument) {
    try {
      fn(argument);
    } catch (error) {
      log(`turn journal: a subscriber threw: ${error?.message ?? error}`);
    }
  }

  /** A whole turn file as it should stand: its meta line, then its events. */
  function fileContents(meta, events) {
    const body = events.map((event) => JSON.stringify(event)).join('\n');
    return `${JSON.stringify(meta)}\n${body ? `${body}\n` : ''}`;
  }

  /**
   * A turn's meta record, read without the rest of its file.
   *
   * The index is built from these and nothing else, so a file that is 2 MiB of
   * frames costs one bounded read rather than a whole-file parse.
   */
  function readMetaLine(path) {
    let fd;
    try {
      fd = io.openSync(path, 'r');
      const buffer = Buffer.allocUnsafe(META_LINE_BYTES);
      const read = io.readSync(fd, buffer, 0, META_LINE_BYTES, 0);
      let line = buffer.toString('utf8', 0, read);
      // A meta record longer than the bounded read (a long error message, say)
      // must not read as no turn at all, so the rare long one falls back to the
      // file it belongs to rather than being invisible to retention and to list.
      if (read === META_LINE_BYTES && !line.includes('\n')) {
        io.closeSync(fd);
        fd = undefined;
        line = io.readFileSync(path, 'utf8');
      }
      const meta = JSON.parse(line.split('\n')[0]);
      if (!meta || typeof meta !== 'object' || typeof meta.turnId !== 'string') return null;
      return meta;
    } catch {
      // A file that is not there, is a directory, or has no readable meta line is
      // not a turn this journal can serve. Retention has nothing to say about it.
      return null;
    } finally {
      if (fd !== undefined) {
        try { io.closeSync(fd); } catch { /* already closed */ }
      }
    }
  }

  /**
   * A turn's file, or null when there is nothing readable to serve. A torn tail
   * from an unclean shutdown costs one frame, not the turn: unparsable event
   * lines are skipped and a meta line that will not parse is treated as no turn
   * at all rather than an exception into a request.
   */
  function readTurnFile(path) {
    let raw;
    try {
      raw = io.readFileSync(path, 'utf8');
    } catch {
      return null;
    }
    const lines = raw.split('\n');
    let meta = null;
    try {
      meta = JSON.parse(lines[0]);
    } catch {
      return null;
    }
    if (!meta || typeof meta !== 'object' || typeof meta.turnId !== 'string') return null;
    const parsed = [];
    for (const line of lines.slice(1)) {
      if (line.trim().length === 0) continue;
      try {
        const event = JSON.parse(line);
        if (typeof event?.seq === 'number' && typeof event.data === 'string') parsed.push(event);
      } catch {
        // Torn frame from a crash mid-append: drop it, keep the rest.
      }
    }
    // The same cap the writer holds, applied to what a read hands back: a file
    // this build wrote is already within it, and one written before it (or one
    // whose last flush raced it) is bounded here rather than streamed whole.
    const events = boundEvents(parsed);
    const shed = events.length - parsed.length;
    if (shed > 0) meta = { ...meta, droppedEvents: (meta.droppedEvents ?? 0) + shed };
    return { meta, events, text: readTextFile(textFileFor(path), events, maxTextBytes) };
  }

  /**
   * At most the turn's cap in event bytes: the newest frames first, and every
   * control frame (a tool call, an error, the model's report - none of which
   * carry text to lose) kept even where it does not fit, within a bound of its
   * own so a log of nothing but tool cards cannot outgrow the cap either.
   */
  function boundEvents(events) {
    let total = 0;
    for (const event of events) total += eventBytes(event);
    if (total <= maxEventBytes) return events;
    const keep = new Array(events.length).fill(false);
    let used = 0;
    let control = 0;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const size = eventBytes(events[index]);
      if (used + size > maxEventBytes) {
        if (isDeltaFrame(events[index].data) || control + size > maxEventBytes) continue;
        control += size;
      }
      keep[index] = true;
      used += size;
    }
    return events.filter((_, index) => keep[index]);
  }

  /**
   * A finished turn's assembled reply, from the sidecar if it has one and from
   * its frames if it does not — an interrupted turn, or a journal whose sidecar
   * never landed, still reads as whatever it managed to say.
   */
  function readTextFile(path, events, cap) {
    try {
      return io.readFileSync(path, 'utf8').slice(0, cap);
    } catch {
      return assembleText(events);
    }
  }

  /** The reply text a turn's frames add up to, capped. */
  function assembleText(events) {
    let text = '';
    for (const event of events) {
      const delta = deltaText(event.data);
      if (!delta || text.length >= maxTextBytes) continue;
      text += delta.slice(0, maxTextBytes - text.length);
    }
    return text;
  }

/**
 * Replace a file with new content, whole: land it in a sibling tmp file, then
 * rename over the target. A reader — the phone re-attaching mid-status-change,
 * or a concurrent list — sees either the old file or the new one, never a
 * half-written one.
 */
  function writeWholeFileAtomic(path, contents) {
    const tmpPath = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      io.writeFileSync(tmpPath, contents, 'utf8');
      renameWithRetry(io, tmpPath, path);
    } catch (error) {
      io.rmSync(tmpPath, { force: true });
      log(`turn journal: could not write ${path}: ${error?.message ?? error}`);
    }
  }

  /** The meta line, rewritten while every event line stays exactly as it is. */
  function rewriteMeta(path, meta) {
    let events = '';
    try {
      events = io.readFileSync(path, 'utf8').split('\n').slice(1).join('\n');
    } catch {
      // No file yet (or it was never persisted): the meta line is all there is.
    }
    writeWholeFileAtomic(path, `${JSON.stringify(meta)}\n${events ? `${events}\n` : ''}`);
  }

  /**
   * The turn's whole file: the meta line, then the events that survived the cap.
   *
   * Written from memory, never by re-reading what is on disk: the frames this
   * process holds ARE the turn, so ending a turn must not pay for a read of
   * everything it has already said, and what it writes is bounded by the cap
   * rather than by whatever an earlier flush happened to leave behind.
   */
  function writeTurnFile(entry) {
    const events = boundEvents(entry.events);
    if (events !== entry.events) {
      const shed = entry.events.length - events.length;
      entry.droppedEvents += shed;
      entry.events = events;
      entry.eventBytes = events.reduce((total, event) => total + eventBytes(event), 0);
      if (entry.droppedEvents) entry.meta.droppedEvents = entry.droppedEvents;
    }
    writeWholeFileAtomic(entry.path, fileContents(entry.meta, events));
    entry.fileBytes = events.reduce((total, event) => total + eventBytes(event), 0);
  }

  function flushEntry(entry) {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (entry.pending.length === 0) return;
    const pendingBytes = entry.pending.reduce((total, event) => total + eventBytes(event), 0);
    // Appending would take the file past the turn's cap — because the frames
    // already flushed are the ones the cap dropped in memory, or because this
    // batch alone is too big — so the file is compacted to what survived instead.
    // Never past the cap: the cap is what bounds a turn's disk cost, and a file
    // that kept every dropped frame grew without one.
    if (entry.fileBytes + pendingBytes > maxEventBytes) {
      entry.pending = [];
      writeTurnFile(entry);
      return;
    }
    const chunk = `${entry.pending.map((event) => JSON.stringify(event)).join('\n')}\n`;
    entry.pending = [];
    try {
      io.appendFileSync(entry.path, chunk);
      entry.fileBytes += pendingBytes;
    } catch (error) {
      log(`turn journal: could not append to ${entry.path}: ${error?.message ?? error}`);
    }
  }

  function armFlush(entry) {
    if (entry.timer || flushMs <= 0) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      flushEntry(entry);
    }, flushMs);
    entry.timer.unref?.();
  }

  /**
   * Hold the per-turn event log to its cap by dropping the OLDEST delta frames.
   *
   * The assembled reply is kept separately (and to a far larger cap), so what a
   * capped turn costs is the ability to replay the exact frame sequence, never
   * the answer itself - and `meta.droppedEvents` says the replay is incomplete
   * rather than presenting a prefix as the whole story. The file is brought back
   * within the cap at the next flush (`flushEntry`), never appended past it.
   */
  function dropForCap(entry) {
    while (entry.eventBytes > maxEventBytes && entry.events.length > 1) {
      let index = entry.events.findIndex((event) => isDeltaFrame(event.data));
      // Nothing but tool frames and telemetry left: drop the oldest of those
      // rather than let the log grow without bound.
      if (index === -1) index = 0;
      const [dropped] = entry.events.splice(index, 1);
      const queued = entry.pending.indexOf(dropped);
      if (queued !== -1) entry.pending.splice(queued, 1);
      entry.eventBytes -= eventBytes(dropped);
      entry.droppedEvents += 1;
      entry.meta.droppedEvents = entry.droppedEvents;
    }
  }

  function endTurn(entry, status, { error = null, reason = null } = {}) {
    if (entry.finished) return;
    entry.finished = true;
    flushEntry(entry);
    const finishedAt = now();
    entry.meta.status = status;
    entry.meta.finishedAt = finishedAt;
    entry.meta.updatedAt = finishedAt;
    entry.meta.error = error;
    entry.meta.reason = reason;
    entry.meta.textLength = entry.text.length;
    if (entry.droppedEvents) entry.meta.droppedEvents = entry.droppedEvents;
    // The whole file, from memory: the status change is the last thing the turn
    // writes, and reading the frames back to rewrite one line above them would
    // cost the turn its entire log on a path the request is waiting on.
    writeTurnFile(entry);
    // Written once, at the end, and never rewritten: the reply a finished turn
    // hands to a phone that was away.
    writeWholeFileAtomic(textFileFor(entry.path), entry.text);
    remember(entry);
    // Only the turn that owns the key may release it: a turn whose id another
    // turn now holds must not evict that one's entry (its Stop is found through
    // it, and its subscribers live on it).
    if (live.get(entry.key) === entry) live.delete(entry.key);
    const subscribers = [...entry.subscribers];
    entry.subscribers.clear();
    for (const notify of subscribers) safeCall(notify, null);
    schedulePrune();
  }

  /**
   * The write handle a running turn holds: it appends frames, reports its
   * sequence number, and closes itself with the one status that describes how
   * the turn ended. After `finish` it is inert - a late frame from a runner
   * that had not noticed the abort is not a new event on a turn already over.
   */
  function handleFor(entry) {
    return {
      append(data) {
        if (entry.finished || typeof data !== 'string') return;
        const at = now();
        const event = { seq: entry.meta.lastSeq + 1, t: at, data };
        entry.meta.lastSeq = event.seq;
        entry.meta.updatedAt = at;
        entry.eventBytes += eventBytes(event);
        entry.pending.push(event);
        entry.events.push(event);
        const delta = deltaText(data);
        if (delta && entry.text.length < maxTextBytes) {
          entry.text += delta.slice(0, maxTextBytes - entry.text.length);
          entry.meta.textLength = entry.text.length;
        }
        dropForCap(entry);
        for (const notify of [...entry.subscribers]) safeCall(notify, event);
        armFlush(entry);
      },
      finish(status, detail) {
        endTurn(entry, status, detail ?? {});
      },
      /** The last sequence number this turn assigned. */
      get seq() {
        return entry.meta.lastSeq;
      },
      /** The reply so far, as the frames have added up to it. */
      get text() {
        return entry.text;
      },
    };
  }

/**
 * Drop finished turns beyond the retention window or the count cap, oldest
 * first, from the index rather than from the disk. A RUNNING turn is never a
 * candidate: it is either being written now, or the process that owned it is
 * gone - and `recoverInterrupted` is what settles those, honestly, at the next
 * start.
 *
 * This is a background task, never something a turn waits on: a sweep that
 * readdir'd every caller's directory and parsed every line of every turn file
 * cost hundreds of MB of blocking I/O on the Gate's one event loop, twice per
 * chat turn. The index is built once, from meta lines only.
 */
async function prune() {
    const cutoff = now() - retentionMs;
    await buildIndex();
    const rows = [...index.values()].filter((row) => row.status !== 'running');
    rows.sort((a, b) => a.at - b.at);
    const excess = Math.max(0, rows.length - maxTurns);
    const doomed = [];
    for (const [position, row] of rows.entries()) {
      if (position < excess || row.at < cutoff) doomed.push(row);
    }
    for (const row of doomed) {
      await io.rm(row.path, { force: true }).catch(() => {});
      // The reply dies with its turn; an orphan sidecar must not answer for a
      // turn id that is issued again later.
      await io.rm(textFileFor(row.path), { force: true }).catch(() => {});
      if (index.get(row.key) === row) index.delete(row.key);
    }
    lastPruneAt = Date.now();
  }

  /** The one startup scan, in meta lines only, then never again. */
  async function buildIndex() {
    if (!indexBuilt) indexBuilt = (async () => {
      const found = [];
      let callers = [];
      try {
        callers = await io.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const caller of callers) {
        if (!caller.isDirectory()) continue;
        let names = [];
        try {
          names = await io.readdir(join(dir, caller.name));
        } catch {
          continue;
        }
        for (const name of names) {
          if (!name.endsWith('.jsonl')) continue;
          const path = join(dir, caller.name, name);
          const meta = readMetaLine(path);
          if (!meta) continue;
          found.push(rowFor(join(caller.name, name), meta, path));
        }
      }
      for (const row of found) index.set(row.key, row);
    })();
    await indexBuilt;
  }

  function rowFor(callerDirName, meta, path) {
    return {
      key: turnKey(meta.callerId ?? callerDirName, meta.turnId),
      callerDir: join(dir, callerDirName),
      turnId: meta.turnId,
      path,
      status: meta.status ?? 'running',
      at: meta.finishedAt ?? meta.updatedAt ?? meta.startedAt ?? 0,
    };
  }

  /** Put (or move) one turn in the index, from the meta this process holds. */
  function remember(entry) {
    const key = turnKey(entry.callerId, entry.turnId);
    index.set(key, rowFor(safeSegment(entry.callerId, 'anonymous'), entry.meta, fileFor(entry.callerId, entry.turnId)));
  }

/**
 * Ask for a sweep, no more than once per interval and never more than one in
 * flight. `begin` and `finish` call this and return: they do no directory scan
 * and read no other turn's file, whatever the retention numbers say.
 */
function schedulePrune() {
    if (closed) return null;
    // A turn asking while a sweep is running must not be answered by it: this
    // sweep started before that turn existed, so the flag is what makes the next
    // one happen when this one is done.
    prunePending = true;
    if (pruneTask) return pruneTask;
    // Wall clock, not the injected `now`: `now` is what a test ages turns with,
    // while how often the sweep may run is a fact about this process's lifetime.
    if (Date.now() - lastPruneAt >= pruneIntervalMs) {
      prunePending = false;
      return runPrune();
    }
    return armSweep();
  }

  /**
   * The sweep's own clock: an interval, not a long timer.
   *
   * An interval because retention is a repeating background task, and a `setTimeout`
   * because a Gate that armed one 60-second timer per chat turn read to the rest
   * of the process like a turn waiting to be reaped. It exists only while a sweep
   * is wanted: an idle tick drops it.
   */
  function armSweep() {
    if (pruneInterval || closed) return null;
    pruneInterval = setInterval(() => {
      if (!prunePending) {
        clearInterval(pruneInterval);
        pruneInterval = null;
        return;
      }
      prunePending = false;
      runPrune();
    }, pruneIntervalMs);
    pruneInterval.unref?.();
    return null;
  }

  function runPrune() {
    pruneTask = prune().catch((error) => {
      log(`turn journal: prune failed: ${error?.message ?? error}`);
    }).finally(() => {
      pruneTask = null;
      armSweep();
    });
    return pruneTask;
  }


  // The first sweep this process makes is the one the turns left on disk need.
  // It is a background task like every later one: nothing waits on it.
  schedulePrune();

  return {
    /**
     * Open a turn's journal and return its write handle. The meta line is written
     * before the first upstream byte, so a turn that dies immediately is still a
     * turn the phone can list.
     *
     * A turn id is used once. Two requests can both find an id unused and then
     * both start one, so this refuses a key that is already live by name
     * (`TurnExistsError`, code `turn_exists`) rather than taking the running
     * turn's file and entry: the caller answers that request as a replay of the
     * turn already running (design 3.3 - a retry is never a second turn).
     */
    begin({ callerId, turnId, sessionId = null, backendId = null, botId = null, model = null } = {}) {
      const key = turnKey(callerId, turnId);
      if (live.has(key)) throw new TurnExistsError(turnId);
      const stamp = now();
      const meta = {
        turnId,
        callerId,
        sessionId,
        backendId,
        botId,
        model,
        status: 'running',
        startedAt: stamp,
        updatedAt: stamp,
        finishedAt: null,
        lastSeq: 0,
        error: null,
        reason: null,
        textLength: 0,
      };
      const entry = {
        key,
        callerId,
        turnId,
        path: fileFor(callerId, turnId),
        meta,
        events: [],
        pending: [],
        text: '',
        eventBytes: 0,
        fileBytes: 0,
        droppedEvents: 0,
        subscribers: new Set(),
        timer: null,
        finished: false,
      };
      try {
        io.mkdirSync(callerDir(callerId), { recursive: true });
        io.writeFileSync(entry.path, `${JSON.stringify(meta)}\n`, 'utf8');
        // A turn id is only ever used once, so anything already here belongs to a
        // turn this one replaces: its frames are gone, so its reply must go too.
        io.rmSync(textFileFor(entry.path), { force: true });
      } catch (error) {
        log(`turn journal: could not open ${entry.path}: ${error?.message ?? error}`);
      }
      live.set(entry.key, entry);
      remember(entry);
      schedulePrune();
      return handleFor(entry);
    },

    /** One turn as `{ ...meta, text }`, or null when this caller has no such turn. */
    async get(callerId, turnId) {
      const entry = live.get(turnKey(callerId, turnId));
      // A turn this process is running is authoritative from memory: its meta on
      // disk only moves when the turn does.
      if (entry) return { ...entry.meta, text: entry.text };
      const read = readTurnFile(fileFor(callerId, turnId));
      return read ? { ...read.meta, text: read.text } : null;
    },

    /** This caller's turns, newest first, optionally filtered by session or status. */
    async list(callerId, { sessionId = null, status = null, limit = 50 } = {}) {
      const rows = [];
      let names = [];
      try {
        names = await io.readdir(callerDir(callerId));
      } catch {
        names = [];
      }
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue;
        // Meta lines only: a list answers with meta, so reading one turn's whole
        // frame log (up to the cap) to fill in fields the answer drops was the
        // most expensive thing this route could do.
        const meta = readMetaLine(join(callerDir(callerId), name));
        if (meta) rows.push(meta);
      }
      for (const entry of live.values()) {
        if (entry.callerId !== callerId) continue;
        const found = rows.findIndex((meta) => meta.turnId === entry.turnId);
        if (found === -1) rows.push({ ...entry.meta });
        else rows[found] = { ...entry.meta };
      }
      return rows
        .filter((meta) => (sessionId ? meta.sessionId === sessionId : true))
        .filter((meta) => (status ? meta.status === status : true))
        .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
        .slice(0, Math.max(0, limit));
    },

    /**
     * Replay every event after `seq`, then follow the turn live.
     *
     * `onEvent` receives `{ seq, t, data }` per frame and then `null` as the
     * terminal marker - the journal has nothing further to say for this turn. A
     * turn this process does not own is already terminal (its owner is gone), so
     * it replays and ends at once. Returns an unsubscribe; releasing it stops
     * the follow and touches nothing about the turn itself, which is what lets a
     * phone walk away from a replay without ending the work.
     */
    async subscribe(callerId, turnId, after, onEvent) {
      const entry = live.get(turnKey(callerId, turnId));
      const events = entry ? entry.events : (readTurnFile(fileFor(callerId, turnId))?.events ?? []);
      for (const event of events) {
        if (event.seq > after) safeCall(onEvent, event);
      }
      if (!entry || entry.finished) {
        safeCall(onEvent, null);
        return () => {};
      }
      entry.subscribers.add(onEvent);
      return () => {
        entry.subscribers.delete(onEvent);
      };
    },

    /**
     * The phone's Stop, as the journal sees it: `cancelled` for a turn that was
     * still running, whether or not this process is the one running it. Returns
     * false when the turn was already over - stopping it twice is not a fact
     * worth recording again.
     */
async cancel(callerId, turnId) {
      const entry = live.get(turnKey(callerId, turnId));
      if (entry) {
        endTurn(entry, 'cancelled', {});
        return true;
      }
      const path = fileFor(callerId, turnId);
      const read = readTurnFile(path);
      if (!read || read.meta.status !== 'running') return false;
      const finishedAt = now();
      const meta = {
        ...read.meta,
        status: 'cancelled',
        finishedAt,
        updatedAt: finishedAt,
      };
      rewriteMeta(path, meta);
      const row = rowFor(safeSegment(callerId, 'anonymous'), meta, path);
      index.set(turnKey(callerId, turnId), row);
      return true;
    },

    /**
     * Settle every turn the journal still shows as running. The process that
     * owned them is gone, so `close()` never got to end them honestly: the only
     * true thing to say is that the Gate restarted while they ran. Returns what
     * it recovered.
     *
     * Meta lines only, for the same reason the sweep is: a startup that read
     * every retained turn whole to learn one word of each is a startup nobody
     * waits for.
     */
    async recoverInterrupted() {
      const recovered = [];
      let callers = [];
      try {
        callers = await io.readdir(dir, { withFileTypes: true });
      } catch {
        return recovered;
      }
      for (const caller of callers) {
        if (!caller.isDirectory()) continue;
        let names = [];
        try {
          names = await io.readdir(join(dir, caller.name));
        } catch {
          continue;
        }
        for (const name of names) {
          if (!name.endsWith('.jsonl')) continue;
          const path = join(dir, caller.name, name);
          const meta = readMetaLine(path);
          if (!meta || meta.status !== 'running') continue;
          const finishedAt = now();
          const settled = {
            ...meta,
            status: 'interrupted',
            reason: 'gate_restart',
            finishedAt,
            updatedAt: finishedAt,
          };
          rewriteMeta(path, settled);
          const row = rowFor(caller.name, settled, path);
          index.set(row.key, row);
          recovered.push({
            turnId: settled.turnId,
            callerId: settled.callerId ?? null,
            sessionId: settled.sessionId ?? null,
          });
        }
      }
      return recovered;
    },

    /**
     * Land every coalesced append and settle the background sweep.
     *
     * Awaitable, and it waits for the sweep as well as the writes, so a caller
     * that has flushed knows nothing of this journal is still touching the disk:
     * a test removing the directory, and a Gate shutting down, both depend on it.
     */
    async flush() {
      for (const entry of [...live.values()]) flushEntry(entry);
      await pruneTask;
    },

    /**
     * Stop flushing, and settle every write and every background task still
     * outstanding. Awaited, because the point of it is that the directory can be
     * touched the moment it returns.
     *
     * Turns still running stay `running` on disk on purpose: the next process's
     * `recoverInterrupted` is what turns them into the honest `interrupted`
     * they are.
     */
    async close() {
      closed = true;
      if (pruneInterval) clearInterval(pruneInterval);
      pruneInterval = null;
      for (const entry of [...live.values()]) {
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = null;
        flushEntry(entry);
      }
      await pruneTask;
    },
  };
}
