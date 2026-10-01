import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSerialReload, createDebouncedReload } from '../core/serial-reload.mjs';
import { createGate } from '../core/server.mjs';
import { CredentialVault } from '../core/credentials/vault.mjs';
import { ProviderService } from '../core/providers/service.mjs';
import { ProviderStore } from '../core/providers/store.mjs';

// Every reload builds a whole snapshot from disk and the server assigns it
// wholesale, so two overlapping reloads that finished out of order left the
// older snapshot on top: a provider created beside a capability instance
// produced two reloads, and the one that read the disk first assigned last, so
// the manifest hid both new entries until something else reloaded.

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A compute the test settles by hand, so a run can be held open. */
function controlledCompute(onStart) {
  const runs = [];
  const compute = () => {
    let settle;
    const result = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    runs.push(settle);
    onStart?.(runs.length);
    return result;
  };
  return { compute, runs };
}

test('an older snapshot cannot win: overlapping calls end on the newest one', async () => {
  // The caller assigns whatever it is handed, exactly as the server does, so
  // what is under test is the order the snapshots are handed back in.
  const { compute, runs } = controlledCompute();
  const reload = createSerialReload(compute);
  let state = null;
  const assign = async (call) => { state = await call; };

  const first = assign(reload());
  await tick();
  assert.equal(runs.length, 1, 'the first caller owns the run that is in flight');

  const second = assign(reload());
  await tick();
  assert.equal(runs.length, 1, 'a caller that arrives during a run must not read the disk beside it');

  runs[0].resolve('older');
  await first;
  await tick();
  assert.equal(runs.length, 2, 'the queued follow-up runs once the one in front of it settles');

  runs[1].resolve('newer');
  await second;
  assert.equal(state, 'newer', 'the snapshot that started last is the one left assigned');
});

test('N overlapping calls cost two computations, not N', async () => {
  const { compute, runs } = controlledCompute();
  const reload = createSerialReload(compute);

  const calls = [reload(), reload(), reload(), reload(), reload()];
  await tick();
  assert.equal(runs.length, 1);
  runs[0].resolve('first');
  await tick();
  assert.equal(runs.length, 2, 'every overlapping caller shares one queued follow-up');

  runs[1].resolve('second');
  assert.deepEqual(await Promise.all(calls), ['first', 'second', 'second', 'second', 'second']);
  assert.equal(runs.length, 2);
});

test('a call made during a run is answered by a computation that started after it', async () => {
  const events = [];
  const { compute, runs } = controlledCompute((n) => events.push(`compute-${n}`));
  const reload = createSerialReload(compute);

  events.push('call-first');
  const first = reload();
  await tick();
  events.push('call-second');
  const second = reload();
  await tick();

  assert.deepEqual(
    events,
    ['call-first', 'compute-1', 'call-second'],
    'the second call must not be answered by the run whose reads began before it asked',
  );

  runs[0].resolve('a');
  await first;
  await tick();
  assert.deepEqual(events, ['call-first', 'compute-1', 'call-second', 'compute-2']);
  runs[1].resolve('b');
  assert.equal(await second, 'b');
});

test('a failed run rejects its own callers without wedging the next one', async () => {
  let calls = 0;
  const reload = createSerialReload(async () => {
    calls += 1;
    if (calls === 1) throw new Error('registry unreadable');
    return `state-${calls}`;
  });

  await assert.rejects(reload(), /registry unreadable/);
  const next = reload();
  // The call that arrives while that run is in flight is queued behind it, so it
  // gets a run of its own rather than a state computed before it asked.
  const overlapping = reload();
  assert.equal(await next, 'state-2');
  assert.equal(await overlapping, 'state-3');
});

test('a rejected run is followed by a real one, twice over', async () => {
  const { compute, runs } = controlledCompute();
  const reload = createSerialReload(compute);

  const first = reload();
  await tick();
  const queued = reload();
  runs[0].reject(new Error('first run failed'));
  await assert.rejects(first, /first run failed/);
  await tick();

  runs[1].reject(new Error('queued run failed'));
  await assert.rejects(queued, /queued run failed/);
  await tick();

  const third = reload();
  await tick();
  assert.equal(runs.length, 3, 'the run after a failed one still happens');
  runs[2].resolve('recovered');
  assert.equal(await third, 'recovered');
});

test('a debounced reload coalesces several outcomes into one run', async () => {
  let reloads = 0;
  const schedule = createDebouncedReload(async () => { reloads += 1; }, { delayMs: 20 });

  schedule();
  schedule();
  schedule();
  assert.equal(reloads, 0, 'the reload is not run on the call that asks for it');
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(reloads, 1);
});

test('a debounced reload swallows a failed run and still runs for the next one', async () => {
  let reloads = 0;
  const schedule = createDebouncedReload(async () => {
    reloads += 1;
    throw new Error('registry unreadable');
  }, { delayMs: 10 });

  schedule();
  await new Promise((resolve) => setTimeout(resolve, 60));
  schedule();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(reloads, 2);
});

// The two RPC surfaces reload the same state and nothing serialised them, so
// this is the collision the serialised reload exists for: the reload that read
// the disk before `beta` existed must not be the one left assigned.
const passthroughBackend = {
  protect: async (buffer) => buffer,
  unprotect: async (buffer) => buffer,
};

function registration(id, overrides = {}) {
  return {
    schemaVersion: 2,
    kind: 'provider',
    id,
    label: id.toUpperCase(),
    providerType: 'openai-compatible',
    enabled: true,
    registration: {
      mode: 'api_key',
      protocol: 'openai_chat',
      baseUrl: 'http://127.0.0.1:1/v1',
      credentialRef: `provider/${id}/api-key`,
    },
    catalogPolicy: { ttlSeconds: 300, allowLastKnownGood: true },
    requestPolicy: { timeoutMs: 5000 },
    ...overrides,
  };
}

test('two overlapping reloads leave the manifest advertising both new providers', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gate-serial-reload-'));
  const gateHome = join(root, '.gate-home');
  await mkdir(join(gateHome, 'config', 'providers'), { recursive: true });
  const vault = new CredentialVault({ gateHome, backend: passthroughBackend });
  await vault.set('provider/alpha/api-key', 'alpha-key');
  const gate = await createGate({ root, port: 0, gateHome, vault });
  try {
    const rpc = (method, params) => fetch(`http://127.0.0.1:${gate.port}/v1/capabilities/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
      body: JSON.stringify({ method, params }),
    }).then((response) => response.json());

    // Armed only once the Gate is up, so the boot reload is not the one held
    // open: the hold has to land on the reload `providers.create` triggers.
    let held = false;
    let release;
    let entered;
    const blocked = new Promise((resolve) => { release = resolve; });
    const holding = new Promise((resolve) => { entered = resolve; });
    const list = ProviderService.prototype.list;
    t.mock.method(ProviderService.prototype, 'list', async function mockedList() {
      const snapshots = await list.call(this);
      if (held) {
        held = false;
        entered();
        await blocked;
      }
      return snapshots;
    });

    held = true;
    const first = rpc('providers.create', registration('alpha'));
    await holding;
    const second = rpc('providers.create', registration('beta'));
    // The snapshot the held run will hand back was taken before `beta` existed,
    // so nothing but the serialisation decides which one the Gate ends on.
    const store = new ProviderStore(gateHome);
    while (!(await store.get('beta'))) await tick();
    await new Promise((resolve) => setTimeout(resolve, 250));
    release();
    await Promise.all([first, second]);

    const manifest = await fetch(`http://127.0.0.1:${gate.port}/.well-known/gateway.json`)
      .then((response) => response.json());
    assert.deepEqual(
      manifest.providers.map((provider) => provider.id).sort(),
      ['alpha', 'beta'],
      'the older snapshot hid a provider that had already been created',
    );
  } finally {
    await gate.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('the manifest follows a real chat turn through the debounced reload', async () => {
  // The provider's base URL is a closed port, so the turn fails for real and
  // the readiness the manifest advertises has to be the one the turn produced.
  const root = await mkdtemp(join(tmpdir(), 'gate-outcome-reload-'));
  const gateHome = join(root, '.gate-home');
  await mkdir(join(gateHome, 'config', 'providers'), { recursive: true });
  await mkdir(join(gateHome, 'state', 'providers'), { recursive: true });
  await writeFile(join(gateHome, 'config', 'providers', 'nim.json'), JSON.stringify(registration('nim')), 'utf8');
  await writeFile(
    join(gateHome, 'state', 'providers', 'nim.json'),
    JSON.stringify({ auth: { state: 'ready' }, readiness: { state: 'ready', checkedAt: new Date().toISOString() } }),
    'utf8',
  );
  const vault = new CredentialVault({ gateHome, backend: passthroughBackend });
  await vault.set('provider/nim/api-key', 'nim-key');
  const gate = await createGate({ root, port: 0, gateHome, vault, outcomeReloadDelayMs: 30 });
  try {
    const advertised = async () => fetch(`http://127.0.0.1:${gate.port}/.well-known/gateway.json`)
      .then((response) => response.json())
      .then((body) => body.providers.find((provider) => provider.id === 'nim'));

    const before = await advertised();
    assert.equal(before.readiness.state, 'ready');

    const turn = await fetch(`http://127.0.0.1:${gate.port}/p/nim/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gate.token}` },
      body: JSON.stringify({ model: 'nim-model', messages: [{ role: 'user', content: 'hi' }], stream: false }),
    });
    await turn.text();
    assert.equal(turn.status, 502, 'a refused upstream is still an upstream failure');

    const deadline = Date.now() + 3000;
    let entry;
    do {
      await new Promise((resolve) => setTimeout(resolve, 20));
      entry = await advertised();
    } while (entry.readiness.state === before.readiness.state && Date.now() < deadline);

    assert.equal(
      entry.readiness.state,
      'degraded',
      'the manifest still advertises the readiness from before the turn that failed',
    );
  } finally {
    await gate.close();
    await rm(root, { recursive: true, force: true });
  }
});