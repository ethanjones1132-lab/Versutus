import { fileURLToPath } from 'node:url';

/**
 * The MCP server Claude Code spawns to ask before a tool call.
 *
 * `--permission-prompt-tool` names one MCP tool, and the JSON it answers is the
 * permission decision. This process exists only for that: it speaks
 * newline-delimited JSON-RPC on stdin/stdout, has no dependency and no SDK, and
 * forwards each call to the Gate's loopback bridge (claude-permissions.mjs),
 * which puts it in front of the operator.
 *
 * Every failure is a denial. A crash here means the CLI has no answer and the
 * turn waits for a tool that will never speak; a denial is a decision the
 * agent can act on.
 */

const SERVER_INFO = { name: 'gate-permissions', version: '1.0.0' };
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
const APPROVE_TOOL = {
  name: 'approve',
  description: 'Ask the Versutus operator to approve a Claude Code tool call, and answer with their ruling.',
  inputSchema: { type: 'object', additionalProperties: true },
};

function result(id, value) {
  return { jsonrpc: '2.0', id, result: value };
}

function errorResponse(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** A denial encoded as the body the Gate would have sent. */
function denial(message) {
  return JSON.stringify({ behavior: 'deny', message });
}

/**
 * POST the tool's arguments to the Gate's bridge and return the body verbatim.
 *
 * Config is read off the environment at call time: the CLI passes it in the MCP
 * server's `env`, and a test sets it after this module is imported.
 */
async function requestApproval(arguments_, { fetchImpl, env }) {
  const url = env.GATE_PERMISSION_URL;
  if (!url) return denial('the Versutus approval bridge is not configured');
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-gate-bridge': env.GATE_PERMISSION_SECRET ?? '',
      },
      // The arguments go over exactly as Claude Code sent them; the Gate is
      // what turns them into a summary and an inbox row.
      body: JSON.stringify(arguments_ ?? {}),
    });
  } catch (error) {
    return denial(`the Versutus approval bridge did not answer: ${error?.message ?? error}`);
  }
  const text = await response.text().catch(() => '');
  if (!response.ok) {
    return denial(`the Versutus approval bridge answered ${response.status}`);
  }
  try {
    JSON.parse(text);
  } catch {
    return denial('the Versutus approval bridge answered something that is not a decision');
  }
  return text;
}

/**
 * One JSON-RPC message in, one response out — or null for a notification.
 *
 * Exported so the protocol can be exercised without a child process; the CLI
 * only ever reaches it through `startPermissionTool`.
 */
export async function handleMessage(message, { fetchImpl = fetch, env = process.env } = {}) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return errorResponse(null, -32600, 'Invalid Request');
  }
  // A notification carries no id and is never answered: `notifications/…`
  // messages are how MCP reports lifecycle events, and a reply would look like
  // a response to a request the client never made.
  if (!Object.hasOwn(message, 'id')) return null;
  if (typeof message.method !== 'string') {
    return errorResponse(message.id, -32600, 'Invalid Request');
  }

  switch (message.method) {
    case 'initialize':
      return result(message.id, {
        // Echo the client's version: this server has no versioned surface of
        // its own, and a mismatch would make the CLI refuse the connection.
        protocolVersion: typeof message.params?.protocolVersion === 'string'
          ? message.params.protocolVersion
          : DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case 'ping':
      return result(message.id, {});
    case 'tools/list':
      return result(message.id, { tools: [APPROVE_TOOL] });
    case 'tools/call': {
      if (message.params?.name !== APPROVE_TOOL.name) {
        return errorResponse(message.id, -32602, `Unknown tool: ${message.params?.name ?? ''}`);
      }
      const text = await requestApproval(message.params?.arguments, { fetchImpl, env });
      return result(message.id, { content: [{ type: 'text', text }] });
    }
    default:
      return errorResponse(message.id, -32601, `Method not found: ${message.method}`);
  }
}

/**
 * Read stdin, answer stdout, one JSON-RPC message per line.
 *
 * Calls are handled in order rather than concurrently: the CLI may only have
 * one permission prompt open at a time anyway, and serialising means two
 * answers can never be written out of order.
 */
export function startPermissionTool({
  input = process.stdin,
  output = process.stdout,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  let buffer = '';
  let queue = Promise.resolve();

  function handleLine(line) {
    const text = line.trim();
    if (!text) return;
    queue = queue.then(async () => {
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        output.write(`${JSON.stringify(errorResponse(null, -32700, 'Parse error'))}\n`);
        return;
      }
      const response = await handleMessage(message, { fetchImpl, env });
      if (response) output.write(`${JSON.stringify(response)}\n`);
    }).catch(() => {
      // One bad line must not end the stream: the next call still deserves an
      // answer, and an unhandled rejection here would take the process down.
    });
  }

  input.setEncoding?.('utf8');
  input.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) handleLine(line);
  });
  input.on('end', () => {
    if (buffer.trim()) handleLine(buffer);
    buffer = '';
  });

  return {
    /** Settles once every message read so far has been answered. */
    settled: () => queue,
  };
}

/** Whether this module was started as `node claude-permission-tool.mjs`. */
function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  return process.platform === 'win32'
    ? entry.toLowerCase() === self.toLowerCase()
    : entry === self;
}

if (invokedDirectly()) startPermissionTool();
