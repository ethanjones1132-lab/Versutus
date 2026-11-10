import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';

import { ApprovalService } from '../core/cli-environments/approvals.mjs';
import {
  compactSummary,
  createPermissionBridge,
  isLoopbackAddress,
} from '../core/cli-environments/claude-permissions.mjs';

/**
 * Claude Code asks for a ruling by calling an MCP tool, which posts the tool
 * call here. This listener puts it in the operator's inbox and answers with the
 * exact body the CLI expects — or with a denial, never a hang.
 */

function post(bridge, body, { secret = bridge.secret, path = '/permission', headers = {} } = {}) {
  const url = new URL(bridge.url);
  url.pathname = path;
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-gate-bridge': secret, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** The inbox row, once the bridge has put it there. */
async function pendingRow(approvals, count = 1) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = approvals.list();
    if (rows.length >= count) return rows[0];
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('no approval reached the inbox');
}

function bridgeWith(options = {}) {
  const approvals = options.approvals ?? new ApprovalService();
  return createPermissionBridge({ approvals, environmentId: 'env-1', ...options });
}

test('an approval lands in the inbox and an approve unblocks it with the input verbatim', async () => {
  const approvals = new ApprovalService();
  const bridge = await bridgeWith({ approvals });
  try {
    const input = { command: 'rm -rf build', options: { recursive: true } };
    const answered = post(bridge, { tool_name: 'Bash', input, session_id: 'session-1' });
    const row = await pendingRow(approvals);

    assert.equal(row.type, 'workspace_write');
    assert.equal(row.environmentId, 'env-1');
    assert.equal(row.operation, 'Bash');
    assert.equal(row.runId, 'session-1');
    assert.equal(row.summary, 'Bash: {"command":"rm -rf build","options":{"recursive":true}}');

    await approvals.decide(row.approvalId, 'approve');
    const body = await (await answered).json();
    assert.deepEqual(body, { behavior: 'allow', updatedInput: input });
  } finally {
    await bridge.close();
  }
});

test('a deny in the inbox unblocks the call with a denial message', async () => {
  const approvals = new ApprovalService();
  const bridge = await bridgeWith({ approvals });
  try {
    const answered = post(bridge, { toolName: 'Write', toolInput: { path: 'a.txt' } });
    const row = await pendingRow(approvals);
    await approvals.decide(row.approvalId, 'deny');
    assert.deepEqual(await (await answered).json(), {
      behavior: 'deny',
      message: 'Denied from the Versutus approval inbox',
    });
  } finally {
    await bridge.close();
  }
});

test('an unanswered call is denied by the bridge when its own timeout runs out', async () => {
  const approvals = new ApprovalService();
  const bridge = await bridgeWith({ approvals, timeoutMs: 20 });
  try {
    const body = await (await post(bridge, { tool: 'Bash', input: { command: 'ls' } })).json();
    assert.equal(body.behavior, 'deny');
    // The entry is settled, not left waiting for an operator who has moved on.
    assert.deepEqual(approvals.list(), []);
  } finally {
    await bridge.close();
  }
});

test('a wrong secret is refused before any approval is created', async () => {
  const approvals = new ApprovalService();
  const bridge = await bridgeWith({ approvals });
  try {
    const response = await post(bridge, { tool_name: 'Bash', input: {} }, { secret: 'not-the-secret' });
    assert.equal(response.status, 403);
    assert.deepEqual(approvals.list(), []);
  } finally {
    await bridge.close();
  }
});

test('the loopback guard refuses anything that did not come from this machine', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('127.10.0.5'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('0:0:0:0:0:0:0:1'), true);
  // What Node actually reports for an IPv4 client on a dual-stack socket.
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);

  assert.equal(isLoopbackAddress('10.0.0.7'), false);
  assert.equal(isLoopbackAddress('::ffff:10.0.0.7'), false);
  assert.equal(isLoopbackAddress('192.168.1.20'), false);
  assert.equal(isLoopbackAddress('fd7a:115c:a1e0::1'), false);
  assert.equal(isLoopbackAddress(''), false);
  assert.equal(isLoopbackAddress(null), false);
  assert.equal(isLoopbackAddress(undefined), false);
});

test('an oversized body is refused as a denial rather than read or hung', async () => {
  const approvals = new ApprovalService();
  const bridge = await bridgeWith({ approvals });
  try {
    const huge = JSON.stringify({ tool_name: 'Write', input: { text: 'x'.repeat(70 * 1024) } });
    const body = await (await post(bridge, huge)).json();
    assert.equal(body.behavior, 'deny');
    assert.deepEqual(approvals.list(), []);
  } finally {
    await bridge.close();
  }
});

test('a stalled oversized body still gets its denial instead of hanging', async () => {
  // A sender that declares more than the cap and then stops writing used to
  // hold the handler open forever, and the CLI's prompt with it. The drain is
  // bounded now: the denial arrives even though the body never ends.
  const approvals = new ApprovalService();
  const bridge = await bridgeWith({ approvals });
  const address = new URL(bridge.url);
  try {
    const answer = await new Promise((resolve, reject) => {
      const request = httpRequest({
        host: address.hostname,
        port: address.port,
        path: address.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(1024 * 1024),
          'x-gate-bridge': bridge.secret,
        },
      }, (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { text += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, text }));
      });
      request.on('error', reject);
      request.write('{"tool_name":"Bash","input":');
      // Deliberately never end().
      setTimeout(() => request.destroy(), 3000).unref();
    });
    assert.equal(answer.status, 200);
    assert.equal(JSON.parse(answer.text).behavior, 'deny');
    assert.deepEqual(approvals.list(), []);
  } finally {
    await bridge.close();
  }
});

test('a malformed body is denied, not answered with a server error', async () => {
  const approvals = new ApprovalService();
  const bridge = await bridgeWith({ approvals });
  try {
    const response = await post(bridge, '{not json');
    assert.equal(response.status, 200);
    assert.equal((await response.json()).behavior, 'deny');
    assert.deepEqual(approvals.list(), []);
  } finally {
    await bridge.close();
  }
});

test('the inbox summary is one flattened line, capped at 160 characters', async () => {
  const approvals = new ApprovalService();
  const bridge = await bridgeWith({ approvals });
  try {
    const answered = post(bridge, {
      tool_name: 'Write',
      input: { text: 'line one\nline two\u2028line three', body: 'y'.repeat(500) },
    });
    const row = await pendingRow(approvals);
    assert.ok(row.summary.startsWith('Write: '));
    assert.ok(row.summary.endsWith('\u2026'), 'a cut summary says it was cut');
    assert.equal(row.summary.length, 160);
    assert.ok(!/[\r\n\u2028\u2029]/.test(row.summary), 'a summary is a single line');
    await approvals.decide(row.approvalId, 'deny');
    await answered;

    assert.equal(compactSummary('Bash', { command: 'a\nb' }), 'Bash: {"command":"a\\nb"}');
    assert.equal(compactSummary('Bash\nNow', {}), 'Bash Now: {}');
  } finally {
    await bridge.close();
  }
});

test('only POST /permission is served', async () => {
  const approvals = new ApprovalService();
  const bridge = await bridgeWith({ approvals });
  try {
    const elsewhere = await post(bridge, { tool_name: 'Bash' }, { path: '/elsewhere' });
    assert.equal(elsewhere.status, 404);

    const wrongMethod = await fetch(bridge.url, {
      headers: { 'x-gate-bridge': bridge.secret },
    });
    assert.equal(wrongMethod.status, 404);
  } finally {
    await bridge.close();
  }
});

test('an approvals service that grants on normalize is answered at once', async () => {
  // The service decides some classes itself (a read is auto-approved), so the
  // bridge must not park a call whose ruling already exists.
  const granted = {
    calls: [],
    async normalize(request) {
      this.calls.push(request);
      return { decision: 'approve' };
    },
    waitForDecision() {
      throw new Error('must not wait for a ruling that already exists');
    },
    async decide() {
      throw new Error('must not decide a ruling that already exists');
    },
    list: () => [],
  };
  const bridge = await bridgeWith({ approvals: granted });
  try {
    const body = await (await post(bridge, { tool_name: 'Read', input: { file_path: 'a.txt' } })).json();
    assert.deepEqual(body, { behavior: 'allow', updatedInput: { file_path: 'a.txt' } });
    assert.equal(granted.calls[0].summary, 'Read: {"file_path":"a.txt"}');
  } finally {
    await bridge.close();
  }
});
