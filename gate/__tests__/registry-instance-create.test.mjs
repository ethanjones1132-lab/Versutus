import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRegistryMethods } from '../core/capabilities/registry-methods.mjs';

// `registry.instances.create` guards the duplicate against `state.instances` --
// a cache -- and then writes with `writeFileAtomic`, which renames over whatever
// is at that path. `loadInstances` skips a registry file it cannot use: a
// v2-shaped record, a `cli-environment`, one that does not parse, an unknown
// kind, a config the kind rejects. Those records are on disk and invisible to the
// guard, so creating one silently destroyed an instance the operator had
// configured, and answered with the new record as if nothing had been lost.

function fakeAgentKind() {
  return {
    kind: 'agent',
    label: 'Agent',
    family: 'agent',
    configFields: [{ key: 'endpoint', label: 'Endpoint', type: 'string', required: true }],
    validate(config) {
      const errors = [];
      if (!config?.endpoint || typeof config.endpoint !== 'string') {
        errors.push({ field: 'endpoint', message: 'must be a non-empty string' });
      }
      return { ok: errors.length === 0, errors };
    },
    toManifestEntry: (instance) => ({ id: instance.id }),
    createHandlers: () => ({}),
  };
}

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'gate-instance-create-'));
  await mkdir(join(root, 'registry'), { recursive: true });
  const kinds = new Map([['agent', fakeAgentKind()]]);
  let instances = [];
  const getState = () => ({ kinds, instances });
  // Mirrors `loadInstances` for the case this is about: a file the kind rejects
  // is skipped with a reason, so it never reaches `state.instances`.
  const reload = async () => {
    const entries = await readdir(join(root, 'registry'));
    instances = [];
    for (const filename of entries) {
      if (!filename.endsWith('.json')) continue;
      const id = filename.slice(0, -'.json'.length);
      const parsed = JSON.parse(await readFile(join(root, 'registry', filename), 'utf8'));
      const kindModule = kinds.get(parsed.kind);
      if (!kindModule) continue;
      if (!kindModule.validate(parsed.config ?? {}).ok) continue;
      instances.push({ id, kind: parsed.kind, label: parsed.label ?? id, config: parsed.config ?? {} });
    }
    instances.sort((a, b) => a.id.localeCompare(b.id));
    return getState();
  };
  const methods = createRegistryMethods({ root, getState, reload });
  return { root, methods, getState };
}

test('creating an instance whose id is on disk is refused, whatever the loaded state holds', async () => {
  const { root, methods, getState } = await harness();
  // A config the kind rejects, so `loadInstances` skips it exactly as it skips
  // a v2-shaped or unparseable record -- on disk, absent from the cache the
  // duplicate guard reads.
  await writeFile(
    join(root, 'registry', 'agent-a.json'),
    JSON.stringify({ kind: 'agent', label: 'Configured agent', config: { endpoint: '' } }, null, 2),
    'utf8',
  );
  await methods['registry.instances.create']({ id: 'other', kind: 'agent', config: { endpoint: 'http://127.0.0.1:1' } });
  assert.equal(getState().instances.some((instance) => instance.id === 'agent-a'), false, 'the premise: the cache does not hold it');

  await assert.rejects(
    () => methods['registry.instances.create']({ id: 'agent-a', kind: 'agent', config: { endpoint: 'http://127.0.0.1:2' } }),
    /already exists/,
  );

  const onDisk = JSON.parse(await readFile(join(root, 'registry', 'agent-a.json'), 'utf8'));
  assert.deepEqual(
    onDisk,
    { kind: 'agent', label: 'Configured agent', config: { endpoint: '' } },
    'the instance the operator configured was replaced with the new record',
  );
});

test('a free id still creates the instance', async () => {
  const { methods } = await harness();

  const created = await methods['registry.instances.create']({
    id: 'agent-b',
    kind: 'agent',
    label: 'Agent B',
    config: { endpoint: 'http://127.0.0.1:9' },
  });

  assert.deepEqual(created, {
    id: 'agent-b',
    kind: 'agent',
    label: 'Agent B',
    config: { endpoint: 'http://127.0.0.1:9' },
  });
});

test('an id freed by a delete can be created again', async () => {
  const { methods } = await harness();
  await methods['registry.instances.create']({ id: 'agent-c', kind: 'agent', config: { endpoint: 'http://127.0.0.1:3' } });
  await methods['registry.instances.delete']({ id: 'agent-c' });

  const created = await methods['registry.instances.create']({
    id: 'agent-c',
    kind: 'agent',
    config: { endpoint: 'http://127.0.0.1:4' },
  });

  assert.equal(created.config.endpoint, 'http://127.0.0.1:4');
});
