/**
 * Process-level guards for the long-running Gate.
 *
 * Node's default for an uncaught exception or an unhandled rejection is to
 * exit, and with no listener at all a rejected promise is an uncaught
 * exception. The Gate serves every phone stream, hands-free call, terminal and
 * in-flight turn from one process, so a single write to a dying child's pipe
 * dropped all of them at once and left the supervisor's 1-60 s restart as the
 * only recovery.
 *
 * These handlers split the failures in two. The ones that mean "the peer went
 * away" are logged and survived — the affected stream ends, the Gate keeps
 * serving. Anything else is logged with its stack and exits deliberately, on
 * the grounds that process state may be corrupt and a fresh process is
 * cheaper than a subtly wrong one.
 */

/** Codes that name a broken pipe, not a broken process. */
const SURVIVABLE_CODES = new Set([
  'EPIPE',
  'ECONNRESET',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_WRITE_AFTER_END',
]);

/**
 * A rejection storm is a bug loop, not bad luck: restarting into it again
 * would spin, so this one earns an exit of its own.
 */
const REJECTION_LIMIT = 20;
const REJECTION_WINDOW_MS = 60_000;

/** Installed guards per process object, so a second install is a no-op. */
const installed = new WeakMap();

/** A rejection's reason, as text: a rejection value is not always an Error. */
function describeReason(reason) {
  if (reason instanceof Error) return reason.stack ?? `${reason.name}: ${reason.message}`;
  if (typeof reason === 'string') return reason;
  try {
    return JSON.stringify(reason) ?? String(reason);
  } catch {
    return String(reason);
  }
}

export function installProcessGuards({ log = console.error, exit = process.exit, proc = process } = {}) {
  const existing = installed.get(proc);
  if (existing) return existing;

  const rejections = [];

  const onRejection = (reason) => {
    rejections.push(Date.now());
    const cutoff = Date.now() - REJECTION_WINDOW_MS;
    while (rejections.length > 0 && rejections[0] < cutoff) rejections.shift();
    log(`[gate] unhandled rejection: ${describeReason(reason)}`);
    if (rejections.length > REJECTION_LIMIT) {
      log(`[gate] ${rejections.length} unhandled rejections in ${REJECTION_WINDOW_MS / 1000}s — a rejection loop, not an unlucky moment; restarting the Gate.`);
      exit(1);
    }
  };

  const onException = (error) => {
    if (SURVIVABLE_CODES.has(error?.code)) {
      log(`[gate] survived ${error.code}: ${error.message}`);
      return;
    }
    log(`[gate] fatal: ${describeReason(error)}`);
    exit(1);
  };

  proc.on('unhandledRejection', onRejection);
  proc.on('uncaughtException', onException);

  const uninstall = () => {
    proc.off('unhandledRejection', onRejection);
    proc.off('uncaughtException', onException);
    installed.delete(proc);
  };
  installed.set(proc, uninstall);
  return uninstall;
}
