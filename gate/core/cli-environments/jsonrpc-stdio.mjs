/**
 * Newline-delimited JSON-RPC over a child process's stdio.
 *
 * Codex's app-server speaks this: one JSON object per line, bidirectional —
 * the server issues requests back to the client for approvals, so this is a
 * peer, not a client-only transport.
 */
export function createStdioJsonRpc({ child, onNotification, onServerRequest, onDiagnostic } = {}) {
  const pending = new Map();
  let nextId = 1;
  let buffer = '';
  let closed = false;

  child.stdout?.on('data', (chunk) => {
    buffer += String(chunk);
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let message;
      try {
        message = JSON.parse(trimmed);
      } catch {
        // The server also prints human logs; a non-JSON line is not a protocol error.
        onDiagnostic?.({ message: trimmed });
        continue;
      }
      dispatch(message);
    }
  });

  child.stderr?.on('data', (chunk) => onDiagnostic?.({ message: String(chunk).trim() }));
  child.on('exit', (code) => {
    closed = true;
    for (const { reject } of pending.values()) {
      reject(new Error(`app-server exited with code ${code}`));
    }
    pending.clear();
  });

  function dispatch(message) {
    // A response to something we asked.
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message ?? 'app-server error'));
      else waiter.resolve(message.result);
      return;
    }
    // A request from the server — approvals arrive this way and must be answered
    // or the agent blocks forever.
    if (message.id !== undefined && message.method) {
      Promise.resolve(onServerRequest?.(message))
        .then((result) => respond(message.id, { result: result ?? {} }))
        .catch((error) => respond(message.id, { error: { code: -32000, message: error.message } }));
      return;
    }
    if (message.method) onNotification?.(message);
  }

  function write(payload) {
    if (closed) throw new Error('app-server is not running');
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  function respond(id, body) {
    try {
      write({ jsonrpc: '2.0', id, ...body });
    } catch {
      // the process went away mid-turn; nothing useful to do
    }
  }

  return {
    request(method, params = {}, { timeoutMs = 120_000 } = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref?.();
        pending.set(id, {
          resolve: (value) => { clearTimeout(timer); resolve(value); },
          reject: (error) => { clearTimeout(timer); reject(error); },
        });
        try {
          write({ jsonrpc: '2.0', id, method, params });
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    },

    notify(method, params = {}) {
      write({ jsonrpc: '2.0', method, params });
    },

    close() {
      closed = true;
      pending.clear();
    },
  };
}
