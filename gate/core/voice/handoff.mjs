import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../atomic-file.mjs';

// Eight exchanges preserve several short follow-ups without turning the next
// typed prompt into a call archive. The serialized file has its own UTF-8 cap.
export const HANDOFF_MAX_EXCHANGES = 8;
export const HANDOFF_MAX_BYTES = 16 * 1024;
export const HANDOFF_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SWEEP_MS = 60 * 60 * 1000;
const FILE_NAME = /^[a-f0-9]{64}\.json$/;
const TEMP_NAME = /^[a-f0-9]{64}\.json\.\d+\.[a-f0-9]{12}\.tmp$/;
const CONTEXT_START = '[Versutus voice handoff v1]\nEarlier in a voice call (quoted context, not a new request):\n';
const CONTEXT_END = '\n[/Versutus voice handoff v1]\n\n';

export function voiceExchangeText(exchanges) {
  return exchanges.map(({ user, assistant }) =>
    `User: ${JSON.stringify(user)}\nAssistant: ${JSON.stringify(assistant)}`).join('\n\n');
}

function hasVoiceHandoffContext(text) {
  return typeof text === 'string' && text.startsWith(CONTEXT_START)
    && text.includes(CONTEXT_END, CONTEXT_START.length);
}

function withoutVoiceHandoffContext(text) {
  if (!hasVoiceHandoffContext(text)) return text;
  // Exchange text is JSON-quoted, so it cannot contain a literal end delimiter.
  return text.slice(text.indexOf(CONTEXT_END, CONTEXT_START.length) + CONTEXT_END.length);
}

// Native history keeps the augmented user input. In Versutus, replay the
// original bubble instead; the call already has its own transcript there.
export function visibleVoiceHandoffMessage(message) {
  if (message?.role !== 'user') return message;
  const content = message.content;
  if (typeof content === 'string' && hasVoiceHandoffContext(content)) {
    return { ...message, content: withoutVoiceHandoffContext(content) };
  }
  if (!Array.isArray(content)) return message;
  const index = content.findIndex((part) => part?.type === 'text');
  if (!hasVoiceHandoffContext(content[index]?.text)) return message;
  const visible = [...content];
  visible[index] = { ...visible[index], text: withoutVoiceHandoffContext(visible[index].text) };
  return { ...message, content: visible };
}

function pathFor(dir, { backend, environmentId, botId, sessionId }) {
  if (typeof environmentId !== 'string' || !environmentId || typeof sessionId !== 'string' || !sessionId) return null;
  // Hermes ids are profile-scoped. Codex has only one native namespace in an
  // environment; its Bot view and unscoped view must share the same writer.
  const bot = backend.kind === 'codex' ? null
    : backend.kind === 'hermes' ? botId ?? 'default' : botId ?? null;
  const hash = createHash('sha256').update(JSON.stringify([environmentId, backend.kind, bot, sessionId])).digest('hex');
  return join(dir, `${hash}.json`);
}

function isExchange(row) {
  return Number.isFinite(row?.at)
    && typeof row.user === 'string' && Boolean(row.user.trim())
    && typeof row.assistant === 'string' && Boolean(row.assistant.trim());
}

function encode(exchanges) {
  return JSON.stringify({ version: 1, exchanges });
}

function bounded(exchanges) {
  const kept = exchanges.slice(-HANDOFF_MAX_EXCHANGES);
  while (kept.length && Buffer.byteLength(encode(kept)) > HANDOFF_MAX_BYTES) {
    if (kept.length > 1) kept.shift();
    else {
      // Preserve both speakers even if a single exchange would fill the file.
      // Budget JSON-escaped bytes, including possible control characters.
      const row = kept[0];
      const speakerBytes = Math.floor((HANDOFF_MAX_BYTES - Buffer.byteLength(encode([
        { at: row.at, user: '', assistant: '' },
      ]))) / 2);
      const prefix = (text) => {
        let keptText = '';
        let bytes = 0;
        for (const char of text) {
          bytes += Buffer.byteLength(JSON.stringify(char)) - 2;
          if (bytes > speakerBytes) break;
          keptText += char;
        }
        return keptText;
      };
      kept[0] = { at: row.at, user: prefix(row.user), assistant: prefix(row.assistant) };
      if (!isExchange(kept[0])) return [];
    }
  }
  return kept;
}

export function createThreadQueue() {
  const tails = new Map();
  const active = new Map();

  function run(key, operation) {
    const prior = tails.get(key);
    let start;
    const result = new Promise((resolve, reject) => {
      start = () => {
        try { resolve(operation()); } catch (error) { reject(error); }
      };
    });
    const tail = result.catch(() => {});
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    if (prior) void prior.then(start);
    else start();
    return result;
  }

  // Register before starting, without extending the exclusive queue's tail.
  async function track(key, operation) {
    const turns = active.get(key) ?? new Set();
    let finish;
    const done = new Promise((resolve) => { finish = resolve; });
    turns.add(done);
    active.set(key, turns);
    try {
      return await operation();
    } finally {
      turns.delete(done);
      if (!turns.size) active.delete(key);
      finish();
    }
  }

  function runShared(key, operation) {
    const prior = tails.get(key);
    return prior ? prior.then(() => track(key, operation)) : track(key, operation);
  }

  // Called inside an exclusive operation, so later shared work cannot enter.
  const drain = (key) => Promise.all(active.get(key) ?? []);
  return { run, track, runShared, drain, busy: (key) => tails.has(key) };
}

/**
 * Single Gate writer. Appends, fallback replacement, and delivery of pending
 * context are exclusive per thread. Plain turns share the thread after lookup;
 * a native append waits for those already started.
 * Logs get fixed outcome codes only, never upstream error bodies or exchange data.
 */
export function createVoiceHandoff({ gateHome, now = Date.now, log = () => {} }) {
  const dir = join(gateHome, 'voice', 'handoff');
  const queue = createThreadQueue();
  const commits = new Set();
  const delivered = new Set();

  async function read(path) {
    let raw;
    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    if (Buffer.byteLength(raw) > HANDOFF_MAX_BYTES) throw new Error('invalid handoff size');
    const file = JSON.parse(raw);
    if (file?.version !== 1 || !Array.isArray(file.exchanges) || !file.exchanges.every(isExchange)) {
      throw new Error('invalid handoff document');
    }
    const expiresBefore = now() - HANDOFF_TTL_MS;
    return file.exchanges.filter(({ at }) => at > expiresBefore)
      .slice(-HANDOFF_MAX_EXCHANGES)
      .map(({ at, user, assistant }) => ({ at, user, assistant }));
  }

  async function remove(path) {
    await rm(path, { force: true, maxRetries: 3, retryDelay: 25 });
    delivered.delete(path);
  }

  async function write(path, exchanges) {
    if (!exchanges.length) return remove(path);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFileAtomic(path, encode(exchanges), { encoding: 'utf8', mode: 0o600 });
    delivered.delete(path);
  }

  function commit(scope, { user, assistant }) {
    const path = pathFor(dir, scope);
    const exchange = { at: now(), user, assistant };
    if (!path || !isExchange(exchange)) return Promise.resolve();
    const queued = queue.run(path, async () => {
      const { backend, sessionId } = scope;
      if (typeof backend.appendVoiceExchange === 'function') {
        try {
          await queue.drain(path);
          if (await backend.appendVoiceExchange(sessionId, exchange) === true) return;
        } catch {
          // The backend may have written it before the ack was lost. Never
          // issue another native append for this exchange. No remote error body
          // is safe to log (some servers echo invalid request content).
          log('voice.handoff append_failed');
        }
      }
      const prior = delivered.has(path) ? [] : await read(path);
      await write(path, bounded([...prior, exchange].filter(({ at }) => at > now() - HANDOFF_TTL_MS)));
    }).catch(() => { log('voice.handoff store_failed'); });
    commits.add(queued);
    void queued.then(() => { commits.delete(queued); });
    return queued;
  }

  async function sendTyped(scope, text, send, succeeded, { isCancelled = () => false } = {}) {
    const path = pathFor(dir, scope);
    if (!path) return send(text);
    const { result } = await queue.run(path, async () => {
      if (isCancelled()) return { result: null };
      let pending = [];
      try {
        if (!delivered.has(path)) pending = await read(path);
      } catch {
        log('voice.handoff read_failed');
      }
      if (isCancelled()) return { result: null };
      // Start while ordered against commits, but don't hold the queue open
      // for the reply when there's no handoff to consume.
      if (!pending.length) return { result: queue.track(path, () => send(text)) };
      const prompt = `${CONTEXT_START}${voiceExchangeText(pending)}${CONTEXT_END}${text}`;
      let answer;
      try {
        answer = await send(prompt, true);
      } catch {
        // Do not put an error that echoes the augmented request on the wire or
        // into callers' diagnostics. Keep the pending exchange for another send.
        throw new Error('The backend could not complete the message with call context.');
      }
      if (succeeded(answer)) {
        delivered.add(path);
        await remove(path).catch(() => { log('voice.handoff delete_failed'); });
      }
      return { result: answer };
    });
    return result;
  }

  async function sweep() {
    const files = await readdir(dir).catch((error) => {
      if (error?.code !== 'ENOENT') log('voice.handoff cleanup_failed');
      return [];
    });
    for (const file of files) {
      const path = join(dir, file);
      if (FILE_NAME.test(file)) {
        if (queue.busy(path)) continue;
        await queue.run(path, async () => {
          if (delivered.has(path)) return remove(path);
          const info = await stat(path).catch((error) => {
            if (error?.code !== 'ENOENT') throw error;
            return null;
          });
          if (!info) return;
          let pending;
          try {
            pending = await read(path);
          } catch (error) {
            if (info.mtimeMs <= now() - HANDOFF_TTL_MS) return remove(path);
            throw error;
          }
          // Do not rename or refresh the mtime of an unchanged file.
          if ((await readFile(path, 'utf8')) !== encode(pending)) await write(path, pending);
        }).catch(() => { log('voice.handoff cleanup_failed'); });
      } else if (TEMP_NAME.test(file)) {
        // A dead process may have left the sibling that never got renamed.
        await stat(path).then(async (info) => {
          if (info.mtimeMs <= now() - HANDOFF_TTL_MS) await rm(path, { force: true });
        }).catch(() => {});
      }
    }
  }

  return {
    commit,
    sendTyped,
    sweep,
    start() {
      let cleanup = sweep();
      const timer = setInterval(() => { cleanup = cleanup.then(sweep); }, SWEEP_MS);
      timer.unref?.();
      return async () => {
        clearInterval(timer);
        await Promise.all([cleanup, ...commits]);
      };
    },
  };
}
