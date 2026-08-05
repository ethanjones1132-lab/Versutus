// Smoke test for the portal identification core against mock gateways.
// Starts three local HTTP servers (hermes-like, custom-manifest, unknown),
// then runs the REAL portal modules (identify.ts / manifest.ts) against them.
//
// Run: npx tsx scripts/smoke-portal.ts
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { fetchGatewayManifest, isGatewayManifest } from '../src/lib/portal/manifest';
import { identifyGateway } from '../src/lib/portal/identify';
import {
  normalizeOpenClawMessage,
  normalizeOpenClawModel,
  normalizeOpenClawSession,
  toOpenClawWsUrl,
} from '../src/lib/portal/openclaw-mapping';
import { METHOD_TO_ROUTE, resolveRoute } from '../src/lib/gateway/rpc-routes';
import { buildCapabilitySnapshot } from '../src/lib/gateway/dashboard';

const servers: Server[] = [];
let failures = 0;

function startServer(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    servers.push(server);
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function json(res: import('node:http').ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

async function main() {
  // 1. Hermes-like gateway: /health + /v1/capabilities, NO manifest.
  const hermesPort = await startServer((req, res) => {
    if (req.url === '/health') {
      json(res, 200, { status: 'ok', platform: 'windows', version: '0.5.0' });
      return;
    }
    if (req.url === '/v1/capabilities') {
      json(res, 200, {
        object: 'capabilities',
        platform: 'windows',
        model: 'hermes-agent',
        auth: { type: 'bearer', required: true },
        runtime: { mode: 'agent', tool_execution: 'local', split_runtime: true, description: 'Hermes API' },
        features: {},
        endpoints: { chat: '/v1/chat/completions' },
      });
      return;
    }
    json(res, 404, { error: 'not found' });
  });

  // 2. Custom gateway: Open Gateway Manifest + grant endpoint, NO fingerprints.
  const customPort = await startServer((req, res) => {
    if (req.url === '/.well-known/gateway.json') {
      json(res, 200, {
        manifest: 'versutus-gateway/v1',
        kind: 'mygate',
        name: 'Lab Gate',
        version: '2.1.0',
        vendor: 'jonesinsrc',
        auth: { schemes: ['challenge-response'], grantPath: '/.well-known/gateway/access' },
        capabilities: { chat: true, runs: true, terminal: false },
      });
      return;
    }
    if (req.url === '/.well-known/gateway/access' && req.method === 'POST') {
      json(res, 202, { status: 'pending', requestId: 'req-123' });
      return;
    }
    json(res, 404, { error: 'not found' });
  });

  // 3. Unknown gateway: /health only.
  const unknownPort = await startServer((req, res) => {
    if (req.url === '/health') {
      json(res, 200, { status: 'ok' });
      return;
    }
    json(res, 404, { error: 'not found' });
  });

  const hermesUrl = `http://127.0.0.1:${hermesPort}`;
  const customUrl = `http://127.0.0.1:${customPort}`;
  const unknownUrl = `http://127.0.0.1:${unknownPort}`;

  console.log('Portal identification smoke — mock gateways on ports', hermesPort, customPort, unknownPort);

  console.log('\n[manifest]');
  const hermesManifest = await fetchGatewayManifest(hermesUrl);
  check('hermes gateway serves no manifest → null', hermesManifest === null, hermesManifest);
  check('manifest validator rejects non-manifest object', !isGatewayManifest({ manifest: 'nope', kind: 'x' }));
  const customManifest = await fetchGatewayManifest(customUrl);
  check('custom gateway manifest fetched', customManifest !== null);
  check(
    'manifest kind preserved',
    customManifest?.kind === 'mygate' && customManifest.auth?.grantPath === '/.well-known/gateway/access',
    customManifest,
  );

  console.log('\n[identify: hermes fingerprint]');
  const hermes = await identifyGateway({ baseUrl: hermesUrl });
  check('kind = hermes', hermes.kind === 'hermes', hermes);
  check('source = probe-hermes', hermes.source === 'probe-hermes', hermes.source);
  check('auth requires token', hermes.auth.requiresToken === true, hermes.auth);
  check('version captured', hermes.version === '0.5.0', hermes.version);

  console.log('\n[identify: custom manifest]');
  const custom = await identifyGateway({ baseUrl: customUrl });
  check('kind = custom', custom.kind === 'custom', custom);
  check('customKindId = mygate', custom.customKindId === 'mygate', custom.customKindId);
  check('source = manifest', custom.source === 'manifest', custom.source);
  check('label = Custom — mygate', custom.kindLabel === 'Custom — mygate', custom.kindLabel);
  check(
    'capabilities mapped',
    !!(custom.capabilities?.includes('chat') && custom.capabilities?.includes('runs')),
    custom.capabilities,
  );

  console.log('\n[identify: unknown]');
  const unknown = await identifyGateway({ baseUrl: unknownUrl });
  check('kind = unknown', unknown.kind === 'unknown', unknown);
  check('http transport hint', unknown.transportHint === 'http', unknown.transportHint);

  console.log('\n[identify: beacon fast path — no network]');
  const beacon = await identifyGateway({ baseUrl: 'http://127.0.0.1:1', beaconKind: 'openclaw' });
  check('kind = openclaw', beacon.kind === 'openclaw', beacon);
  check('source = beacon', beacon.source === 'beacon', beacon.source);
  check('ws transport hint', beacon.transportHint === 'ws', beacon.transportHint);

  console.log('\n[identify: unreachable → unknown, no throw]');
  const dead = await identifyGateway({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 3000 });
  check('kind = unknown', dead.kind === 'unknown', dead);
  check('no transport hint', dead.transportHint === undefined, dead.transportHint);

  console.log('\n[openclaw mapping]');
  check(
    'http base → ws /openclaw',
    toOpenClawWsUrl('http://10.0.0.5:8642') === 'ws://10.0.0.5:8642/openclaw',
    toOpenClawWsUrl('http://10.0.0.5:8642'),
  );
  check(
    'https base → wss /openclaw',
    toOpenClawWsUrl('https://pc.ts.net:8642/') === 'wss://pc.ts.net:8642/openclaw',
    toOpenClawWsUrl('https://pc.ts.net:8642/'),
  );
  check(
    'ws url passthrough without double path',
    toOpenClawWsUrl('ws://host:9999/openclaw') === 'ws://host:9999/openclaw',
    toOpenClawWsUrl('ws://host:9999/openclaw'),
  );
  const session = normalizeOpenClawSession({ sessionId: 's-1', title: 'Ops', startedAt: 1234, model: 'grok' });
  check('session: id from sessionId', session?.id === 's-1', session);
  check('session: title + started_at mapped', session?.title === 'Ops' && session?.started_at === 1234, session);
  check(
    'session: rejected when no id',
    normalizeOpenClawSession({ title: 'No id' }) === null,
    normalizeOpenClawSession({ title: 'No id' }),
  );
  const message = normalizeOpenClawMessage({ sender: 'assistant', text: 'hello world', timestamp: 99 });
  check(
    'message: role fallback + content mapped',
    message?.role === 'assistant' && message?.content === 'hello world' && message?.timestamp === 99,
    message,
  );
  check(
    'message: unknown role rejected',
    normalizeOpenClawMessage({ sender: 'robot', text: 'x' }) === null,
    normalizeOpenClawMessage({ sender: 'robot', text: 'x' }),
  );
  check(
    'model: id fallback to model key',
    normalizeOpenClawModel({ model: 'deepseek-r1' })?.id === 'deepseek-r1',
    normalizeOpenClawModel({ model: 'deepseek-r1' }),
  );

  console.log('\n[hermes rpc route map]');
  const sessionMessages = resolveRoute('session.messages', { sessionId: 's-42', limit: 80 });
  check(
    'path placeholder interpolated + query built',
    sessionMessages?.path === '/api/sessions/s-42/messages?limit=80',
    sessionMessages?.path,
  );
  const sessionGet = resolveRoute('session.get', { sessionId: 's-7' });
  check('session.get interpolated', sessionGet?.path === '/api/sessions/s-7', sessionGet?.path);
  check(
    'cron.list → jobs api',
    resolveRoute('cron.list')?.path === '/api/jobs',
    resolveRoute('cron.list')?.path,
  );
  check(
    'model.options → rich inventory',
    resolveRoute('model.options')?.path === '/api/model/options',
    resolveRoute('model.options')?.path,
  );
  check(
    'diagnostics.full → health/detailed',
    resolveRoute('diagnostics.full')?.path === '/health/detailed',
    resolveRoute('diagnostics.full')?.path,
  );
  check('unknown method → null', resolveRoute('config.patch') === null);
  check('route count grew', Object.keys(METHOD_TO_ROUTE).length >= 17, Object.keys(METHOD_TO_ROUTE).length);

  console.log('\n[capability snapshot with live features]');
  const noFeatures = buildCapabilitySnapshot('connected', { type: 'hello-ok', protocol: 1, server: {} });
  check('no scopes + no features → warming', noFeatures.status === 'warming', noFeatures.status);
  const withFeatures = buildCapabilitySnapshot(
    'connected',
    { type: 'hello-ok', protocol: 1, server: {} },
    undefined,
    Date.now(),
    {
      object: 'hermes.api_server.capabilities',
      platform: 'hermes-agent',
      model: 'hermes-agent',
      auth: { type: 'bearer', required: true },
      runtime: { mode: 'agent', tool_execution: 'local', split_runtime: false, description: 'x' },
      features: { chat_completions: true, responses_api: true, run_submission: true, run_stop: true },
      endpoints: {},
    },
  );
  const chatGroup = withFeatures.groups.find((group) => group.id === 'chat');
  check('chat group ready from features', chatGroup?.status === 'ready', chatGroup);
  check('overall fresh from features', withFeatures.status === 'fresh', withFeatures.status);

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((error) => {
    console.error('Smoke crashed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const server of servers) {
      server.closeAllConnections?.();
      server.close();
    }
  });
