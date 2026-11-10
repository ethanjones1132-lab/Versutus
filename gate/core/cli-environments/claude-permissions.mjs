import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';

/**
 * The Gate's half of Claude Code's permission prompt.
 *
 * Claude Code has no approval pipe of its own: `--permission-prompt-tool` names
 * an MCP tool it calls before a tool it considers risky runs, and that tool's
 * answer *is* the ruling. So a turn is given a small MCP server (see
 * claude-permission-tool.mjs) that forwards the call here, and this listener
 * turns it into the same inbox entry a Codex approval becomes — the operator
 * rules on the phone, and the turn continues or stops on that ruling.
 *
 * The listener is loopback-only and carries a per-bridge secret: the CLI is a
 * local process, and nothing on the machine should be able to answer an
 * approval just by finding the port.
 */

const MAX_BODY_BYTES = 64 * 1024;
const SUMMARY_LIMIT = 160;
/** How long an oversized body may keep draining before the denial is sent anyway. */
const DRAIN_LIMIT_MS = 1_000;
const DENY_MESSAGE = 'Denied from the Versutus approval inbox';

/**
 * Whether a peer address is this machine.
 *
 * Node reports an IPv4 client on a dual-stack socket as `::ffff:127.0.0.1`, so
 * the mapped form is unwrapped before the check; anything else — a LAN
 * address, a tailnet address, a proxy — is refused. The bind address already
 * says loopback, and this is the second lock: a request that did not come from
 * here never reaches the inbox whatever the headers say.
 */
export function isLoopbackAddress(address) {
  if (typeof address !== 'string' || !address) return false;
  const bare = address.replace(/^::ffff:/i, '');
  const family = isIP(bare);
  if (family === 4) return /^127\./.test(bare);
  if (family === 6) return bare === '::1' || bare === '0:0:0:0:0:0:0:1';
  return false;
}

/** Too large to be a tool call, refused without ever being buffered. */
class BodyTooLarge extends Error {}

/**
 * Read a JSON body with a ceiling.
 *
 * An oversized body is drained rather than destroyed: the answer is still a
 * denial the CLI can act on, and a reset socket would leave it guessing. The
 * declared length is checked first so a flood is refused before it is read.
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      // Refused without buffering. The drain is bounded rather than trusting
      // the sender to finish: a client that stalls mid-body would otherwise
      // hold this promise — and the CLI's prompt — open forever. A denial is
      // still the answer; the wait is what gets capped.
      let timer;
      const settle = () => {
        clearTimeout(timer);
        reject(new BodyTooLarge('request body too large'));
      };
      timer = setTimeout(settle, DRAIN_LIMIT_MS);
      timer.unref?.();
      req.on('end', settle);
      req.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) reject(new BodyTooLarge('request body too large'));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

/** The one line the inbox shows, flattened and bounded like the Codex path. */
export function compactSummary(tool, input) {
  let rendered;
  try {
    rendered = JSON.stringify(input ?? {});
  } catch {
    rendered = '';
  }
  const raw = `${tool}: ${rendered}`.replace(/[\r\n\u2028\u2029]+/g, ' ').trim();
  // The inbox shows only this line, and the operator approves the whole input,
  // so a cut has to be visible: an approval that looks complete but hides the
  // end of a command is worse than a shorter one that admits it.
  if (raw.length <= SUMMARY_LIMIT) return raw;
  return `${raw.slice(0, SUMMARY_LIMIT - 1)}\u2026`;
}

/** Answer a request; a response already ended is left alone. */
function send(res, status, body) {
  if (res.writableEnded) return;
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/** A refusal the CLI treats as "do not run this tool", never a transport error. */
function deny(res, message = DENY_MESSAGE) {
  send(res, 200, { behavior: 'deny', message });
}

/** The body's tool name, under any of the names the CLI has used. */
function toolName(body) {
  for (const candidate of [body.tool_name, body.toolName, body.tool]) {
    if (typeof candidate === 'string' && candidate) return candidate;
  }
  return 'tool';
}

/** The body's tool input, kept verbatim when it is an object. */
function toolInput(body) {
  const input = body.input ?? body.tool_input ?? body.toolInput;
  return input && typeof input === 'object' && !Array.isArray(input) ? input : {};
}

/**
 * Start the loopback bridge and resolve once it is listening.
 *
 * `close()` resolves when the listener has stopped, so a test — or a Gate
 * shutting down — can prove nothing is still accepting.
 */
export async function createPermissionBridge({
  approvals,
  environmentId,
  timeoutMs = 120_000,
} = {}) {
  const secret = randomBytes(16).toString('hex');

  /** The inbox's ruling for one tool call, or a denial when it cannot be had. */
  async function rulingFor(body) {
    if (!approvals || typeof approvals.normalize !== 'function') {
      return { behavior: 'deny', message: DENY_MESSAGE };
    }
    const tool = toolName(body);
    const input = toolInput(body);
    const normalized = await approvals.normalize({
      type: 'workspace_write',
      // The session id is the run the app is showing; where the CLI sends none
      // the entry is the environment's alone, exactly as Codex's null thread is.
      runId: body.session_id ?? body.sessionId ?? null,
      environmentId,
      operation: tool,
      summary: compactSummary(tool, input),
    });

    let ruling = normalized;
    if (ruling?.decision !== 'approve' && ruling?.decision !== 'deny') {
      // The same race the Codex approval path runs: the operator's ruling, or
      // a denial this side makes when nobody has answered in time.
      const waiting = approvals.waitForDecision(ruling?.approvalId);
      let timer;
      const timeout = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          Promise.resolve(approvals.decide(ruling?.approvalId, 'deny')).then(resolve, reject);
        }, timeoutMs);
        timer.unref?.();
      });
      try {
        ruling = await Promise.race([waiting, timeout]);
      } finally {
        clearTimeout(timer);
      }
    }

    return ruling?.decision === 'approve'
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: DENY_MESSAGE };
  }

  async function handle(req, res) {
    // Both locks come before a byte of the body: the peer must be this machine
    // and the caller must hold the secret this bridge minted. The body is only
    // drained, never parsed, so a refused caller learns nothing by sending one.
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      req.resume();
      send(res, 403, { error: 'forbidden' });
      return;
    }
    if (req.headers['x-gate-bridge'] !== secret) {
      req.resume();
      send(res, 403, { error: 'forbidden' });
      return;
    }
    let pathname;
    try {
      pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    } catch {
      pathname = '';
    }
    if (req.method !== 'POST' || pathname !== '/permission') {
      req.resume();
      send(res, 404, { error: 'not found' });
      return;
    }

    let answer;
    try {
      const raw = await readBody(req, MAX_BODY_BYTES);
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        // A body that is not JSON is a call we cannot read, so it is refused
        // rather than thrown: the CLI must always get a decision.
        deny(res);
        return;
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        deny(res);
        return;
      }
      answer = await rulingFor(body);
    } catch {
      // Too large, or an inbox that failed: still a denial, never a hang and
      // never a 500 the CLI would report as a broken tool.
      deny(res);
      return;
    }
    send(res, 200, answer);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      try {
        deny(res);
      } catch {
        // the socket is already gone; nothing is waiting on an answer
      }
    });
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
  // The bridge must not be the reason a Gate that is otherwise finished keeps
  // its process alive; its own lifecycle is the manager's to close.
  server.unref?.();

  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/permission`,
    secret,
    close() {
      if (!server.listening) return Promise.resolve();
      return new Promise((resolve) => {
        server.close(() => resolve());
        // An MCP tool holding a keep-alive connection would otherwise keep
        // `close()` from ever calling back.
        server.closeAllConnections?.();
      });
    },
  };
}
