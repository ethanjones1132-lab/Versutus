import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateId,
  templateValueForField,
  buildInstanceConfigTemplate,
  getKindTemplate,
  describeStartFailure,
  resolveStartPort,
  startFailureExitCode,
  classifyBindHost,
  resolvePlaintextAck,
  plaintextBindError,
} from '../core/cli-helpers.mjs';

test('validateId accepts lowercase alphanumeric with hyphens', () => {
  assert.equal(validateId('my-kind-1'), true);
});

test('validateId rejects uppercase, spaces, and empty', () => {
  assert.equal(validateId('My-Kind'), false);
  assert.equal(validateId('bad id'), false);
  assert.equal(validateId(''), false);
  assert.equal(validateId(undefined), false);
});

test('templateValueForField uses the declared default when present', () => {
  assert.equal(templateValueForField({ type: 'boolean', default: true }), true);
  assert.equal(templateValueForField({ type: 'string', default: 'x' }), 'x');
});

test('templateValueForField returns a type-appropriate placeholder when no default', () => {
  assert.equal(templateValueForField({ type: 'string' }), '');
  assert.deepEqual(templateValueForField({ type: 'string-list' }), []);
  assert.equal(templateValueForField({ type: 'number' }), 0);
  assert.equal(templateValueForField({ type: 'boolean' }), false);
  assert.equal(templateValueForField({ type: 'secret-ref' }), 'ENV_VAR_NAME_HERE');
});

test('templateValueForField uses the first enum option when no default', () => {
  assert.equal(templateValueForField({ type: 'enum', options: ['a', 'b'] }), 'a');
});

test('templateValueForField falls back to empty string for an enum with no options', () => {
  assert.equal(templateValueForField({ type: 'enum' }), '');
});

test('buildInstanceConfigTemplate builds one entry per configField, keyed correctly', () => {
  const configFields = [
    { key: 'flavor', type: 'enum', options: ['openai', 'anthropic'] },
    { key: 'apiKeyEnv', type: 'secret-ref' },
    { key: 'models', type: 'string-list' },
    { key: 'streaming', type: 'boolean', default: true },
  ];
  assert.deepEqual(buildInstanceConfigTemplate(configFields), {
    flavor: 'openai',
    apiKeyEnv: 'ENV_VAR_NAME_HERE',
    models: [],
    streaming: true,
  });
});

test('buildInstanceConfigTemplate returns an empty object for no fields', () => {
  assert.deepEqual(buildInstanceConfigTemplate([]), {});
  assert.deepEqual(buildInstanceConfigTemplate(undefined), {});
});

test('getKindTemplate produces importable ESM naming the given kind/label/family', () => {
  const source = getKindTemplate('cron', 'Scheduled jobs', 'cron');
  assert.match(source, /kind: "cron"/);
  assert.match(source, /label: "Scheduled jobs"/);
  assert.match(source, /family: "cron"/);
  assert.match(source, /export default \{/);
});

test('getKindTemplate output is actually valid, importable JS', async () => {
  const { writeFile, mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');

  const dir = await mkdtemp(join(tmpdir(), 'cli-helpers-kind-'));
  const filePath = join(dir, 'kind.mjs');
  await writeFile(filePath, getKindTemplate('cron', 'Scheduled jobs', 'cron'), 'utf8');

  const module = await import(pathToFileURL(filePath).href);
  assert.equal(module.default.kind, 'cron');
  assert.equal(module.default.label, 'Scheduled jobs');
  assert.equal(module.default.family, 'cron');
  assert.deepEqual(module.default.configFields, []);
  assert.deepEqual(module.default.validate({}), { ok: true, errors: [] });
  assert.deepEqual(module.default.createHandlers({ id: 'x' }), {});
});

test('getKindTemplate safely escapes a label containing a quote and apostrophe', async () => {
  const { writeFile, mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');

  const dir = await mkdtemp(join(tmpdir(), 'cli-helpers-kind-quote-'));
  const filePath = join(dir, 'kind.mjs');
  await writeFile(filePath, getKindTemplate('note', `O'Brien's "Notes"`, 'note'), 'utf8');

  const module = await import(pathToFileURL(filePath).href);
  assert.equal(module.default.label, `O'Brien's "Notes"`);
});

test('describeStartFailure turns a held port into guidance naming the port and the check URL', () => {
  const text = describeStartFailure(
    Object.assign(new Error('listen EADDRINUSE: address already in use :::8760'), { code: 'EADDRINUSE' }),
  );
  assert.match(text, /port 8760/);
  assert.match(text, /gateway\.json/);
  assert.match(text, /Gate that is still running/);
});

test('describeStartFailure appends the check URL to the lock-held refusal', () => {
  const text = describeStartFailure(
    new Error('Gate instance lock is already held — another Gate is already running'),
  );
  assert.match(text, /another Gate is already running/);
  assert.match(text, /gateway\.json/);
});

test('describeStartFailure passes any other failure through with its message', () => {
  const text = describeStartFailure(new Error('LOCALAPPDATA is required'));
  assert.equal(text, 'Error starting gate: LOCALAPPDATA is required');
});

test('describeStartFailure survives a nullish error', () => {
  assert.match(describeStartFailure(null), /Error starting gate:/);
});

test('resolveStartPort defaults to 8760 with no flag and no env', () => {
  assert.deepEqual(resolveStartPort([], {}), { port: 8760 });
});

test('resolveStartPort honors the --port flag', () => {
  assert.deepEqual(resolveStartPort(['--port', '8765'], {}), { port: 8765 });
});

test('resolveStartPort falls back to VERSUTUS_GATE_PORT when no flag is given', () => {
  assert.deepEqual(resolveStartPort([], { VERSUTUS_GATE_PORT: '9000' }), { port: 9000 });
});

test('resolveStartPort lets the --port flag win over the env override', () => {
  assert.deepEqual(resolveStartPort(['--port', '8765'], { VERSUTUS_GATE_PORT: '9000' }), { port: 8765 });
});

test('resolveStartPort rejects non-integer, out-of-range, and missing values', () => {
  assert.ok(resolveStartPort(['--port', 'abc'], {}).error);
  assert.ok(resolveStartPort(['--port', '0'], {}).error);
  assert.ok(resolveStartPort(['--port', '70000'], {}).error);
  assert.ok(resolveStartPort(['--port', '8.5'], {}).error);
  // A bare flag with no value must be refused, not silently defaulted.
  assert.ok(resolveStartPort(['--port'], {}).error);
  assert.ok(resolveStartPort([], { VERSUTUS_GATE_PORT: 'not-a-port' }).error);
});

test('resolveStartPort treats an empty env override as unset', () => {
  assert.deepEqual(resolveStartPort([], { VERSUTUS_GATE_PORT: '' }), { port: 8760 });
});

test('startFailureExitCode is 75 for a held port or lock, 1 otherwise', () => {
  const addrInUse = new Error('listen EADDRINUSE :::8760');
  addrInUse.code = 'EADDRINUSE';
  assert.equal(startFailureExitCode(addrInUse), 75);
  assert.equal(startFailureExitCode(new Error('Gate instance lock is already held — x')), 75);
  assert.equal(startFailureExitCode(new Error('LOCALAPPDATA is required')), 1);
  assert.equal(startFailureExitCode(null), 1);
});

test('resolveStartHost defaults to loopback, per the design spec', async () => {
  const { resolveStartHost } = await import('../core/cli-helpers.mjs');
  assert.deepEqual(resolveStartHost([], {}), { host: '127.0.0.1' });
  assert.deepEqual(resolveStartHost([], { VERSUTUS_GATE_HOST: '' }), { host: '127.0.0.1' });
});

test('resolveStartHost takes --host over VERSUTUS_GATE_HOST and accepts IP literals only', async () => {
  const { resolveStartHost, isLoopbackHost } = await import('../core/cli-helpers.mjs');
  assert.deepEqual(resolveStartHost([], { VERSUTUS_GATE_HOST: '0.0.0.0' }), { host: '0.0.0.0' });
  assert.deepEqual(resolveStartHost(['--host', '100.101.102.103'], { VERSUTUS_GATE_HOST: '0.0.0.0' }), { host: '100.101.102.103' });
  assert.deepEqual(resolveStartHost(['--host', '[::1]'], {}), { host: '::1' });
  assert.deepEqual(resolveStartHost(['--host', 'localhost'], {}), { host: 'localhost' });
  assert.ok(resolveStartHost(['--host'], {}).error);
  assert.ok(resolveStartHost(['--host', '--port'], {}).error);
  assert.ok(resolveStartHost(['--host', 'my-mac.tailnet.ts.net'], {}).error);
  assert.ok(resolveStartHost([], { VERSUTUS_GATE_HOST: '999.1.1.1' }).error);
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
});

test('classifyBindHost: loopback addresses stay on this machine', () => {
  for (const host of ['127.0.0.1', '127.8.9.10', '::1', 'localhost']) {
    assert.equal(classifyBindHost(host), 'loopback', host);
  }
});

test('classifyBindHost: Tailscale addresses are tailnet, at the range boundaries', () => {
  for (const host of ['100.64.0.0', '100.101.102.103', '100.127.255.255', 'fd7a:115c:a1e0::1', 'FD7A:115C:A1E0::ABCD', 'fd7a:115c:a1e0:0:0:0:0:2']) {
    assert.equal(classifyBindHost(host), 'tailnet', host);
  }
});

test('classifyBindHost: wildcard, LAN and public addresses are plaintext, including the CGNAT boundaries', () => {
  for (const host of ['0.0.0.0', '::', '192.168.1.5', '10.0.0.1', '8.8.8.8', '100.63.255.255', '100.128.0.0', 'fd7a:115c:a1e1::1', '2001:db8::1']) {
    assert.equal(classifyBindHost(host), 'plaintext', host);
  }
});

test('classifyBindHost: a zone-scoped link-local address is plaintext today', () => {
  // `fe80::1%eth0` names the interface its link-local address belongs to. The
  // zone suffix is not parsed here, and a link-local address reaches the LAN,
  // so it must be treated as plaintext rather than loopback or tailnet.
  assert.equal(classifyBindHost('fe80::1%eth0'), 'plaintext');
});

test('classifyBindHost: an IPv4-mapped IPv6 LAN address is plaintext today', () => {
  // `::ffff:192.168.1.5` is a LAN address wearing IPv6 notation; it is neither
  // loopback nor Tailscale, so the plaintext warning still applies.
  assert.equal(classifyBindHost('::ffff:192.168.1.5'), 'plaintext');
});

test('resolvePlaintextAck accepts the flag or VERSUTUS_GATE_ALLOW_PLAINTEXT=1 only', () => {
  assert.equal(resolvePlaintextAck(['--allow-plaintext'], {}), true);
  assert.equal(resolvePlaintextAck([], { VERSUTUS_GATE_ALLOW_PLAINTEXT: '1' }), true);
  assert.equal(resolvePlaintextAck([], { VERSUTUS_GATE_ALLOW_PLAINTEXT: 'true' }), false);
  assert.equal(resolvePlaintextAck([], {}), false);
});

test('plaintextBindError names the host, the flag, and Tailscale', () => {
  const message = plaintextBindError('0.0.0.0');
  assert.match(message, /0\.0\.0\.0/);
  assert.match(message, /--allow-plaintext/);
  assert.match(message, /Tailscale/);
});
