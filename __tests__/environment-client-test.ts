import {
  buildEnvironmentRecord,
  buildEnvironmentUpdatePatch,
  createEnvironmentClient,
  snapshotToEditInput,
} from '@/lib/gateway/environment-client';
import type { EnvironmentSnapshot } from '@/lib/gateway/environment-types';

describe('environment client', () => {
  it('starts a run and lists commands without treating CLI output as catalog data', async () => {
    const client = createEnvironmentClient(async <T,>(method: string, params?: Record<string, unknown>) => {
      if (method === 'environments.commands.list') {
        return { status: { machineReadable: true, risk: 'read' } } as T;
      }
      if (method === 'environments.check') {
        return { id: params?.id, state: 'ready' } as T;
      }
      return { ok: true } as T;
    });
    const commands = await client.listCommands('codex-local');
    expect(commands.status.machineReadable).toBe(true);
    const checked = await client.check('codex-local');
    expect(checked.state).toBe('ready');
  });
});

const SNAPSHOT: EnvironmentSnapshot = {
  id: 'hermes-local',
  label: 'Hermes (local)',
  adapterId: 'hermes',
  enabled: true,
  providerRefs: ['openai-primary'],
  state: 'failed',
  executable: { path: 'C:\\Users\\you\\venv\\Scripts\\herems.exe' },
  protocolPreference: ['acp', 'prompt'],
  versionPolicy: { supported: '>=0.18', adapterRevision: '2026-08-14' },
  workspacePolicy: {
    defaultRoot: 'C:\\Projects\\Demo',
    defaultSandbox: 'read_only',
    roots: ['C:\\Projects\\Demo'],
    allowAdditionalRoots: false,
  },
  lifecycle: { startup: 'on_demand', maxConcurrentRuns: 1 },
  // Reported by current Gates so edits can carry bindings; older Gates omit
  // the field and the form must treat that as "unknown", never "none".
  credentialBindings: { ANTHROPIC_API_KEY: 'provider/anthropic-main/api-key' },
};

describe('snapshotToEditInput', () => {
  it('prefills an edit input from the live snapshot without needing the adapter catalog', () => {
    const input = snapshotToEditInput(SNAPSHOT);
    expect(input.id).toBe('hermes-local');
    expect(input.label).toBe('Hermes (local)');
    expect(input.adapter.adapterId).toBe('hermes');
    // Protocol/version policy come from the record itself, not a catalog call.
    expect(input.adapter.protocols).toEqual(['acp', 'prompt']);
    expect(input.adapter.supportedCliVersions).toBe('>=0.18');
    expect(input.executablePath).toBe('C:\\Users\\you\\venv\\Scripts\\herems.exe');
    expect(input.workspaceRoot).toBe('C:\\Projects\\Demo');
    expect(input.providerRefs).toEqual(['openai-primary']);
    // A copy — editing the form must not mutate the snapshot in place.
    expect(input.providerRefs).not.toBe(SNAPSHOT.providerRefs);
    expect(input.adapter.protocols).not.toBe(SNAPSHOT.protocolPreference);
  });

  it('tolerates a snapshot that predates version-policy reporting', () => {
    const bare: EnvironmentSnapshot = { ...SNAPSHOT, versionPolicy: undefined };
    const input = snapshotToEditInput(bare);
    expect(input.adapter.supportedCliVersions).toBe('');
    expect(input.adapter.adapterRevision).toBe('');
  });

  it('carries credential bindings as a copy, and absence stays absence', () => {
    const input = snapshotToEditInput(SNAPSHOT);
    // The mapping round-trips so an edit does not silently drop bindings.
    expect(input.credentialBindings).toEqual({
      ANTHROPIC_API_KEY: 'provider/anthropic-main/api-key',
    });
    // A copy — editing the form must not mutate the snapshot in place.
    expect(input.credentialBindings).not.toBe(SNAPSHOT.credentialBindings);

    // A Gate that does not report bindings leaves the field undefined: the
    // edit must say nothing about bindings rather than claim "none".
    const unreported: EnvironmentSnapshot = { ...SNAPSHOT, credentialBindings: undefined };
    expect(snapshotToEditInput(unreported).credentialBindings).toBeUndefined();
  });
});

describe('buildEnvironmentUpdatePatch', () => {
  it('fixes the executable path while preserving the stored workspace policy', () => {
    const input = {
      ...snapshotToEditInput(SNAPSHOT),
      executablePath: 'C:\\Users\\you\\venv\\Scripts\\hermes.exe',
    };
    const patch = buildEnvironmentUpdatePatch(input, SNAPSHOT);
    expect(patch.adapterId).toBe('hermes');
    expect(patch.executable).toEqual({ path: 'C:\\Users\\you\\venv\\Scripts\\hermes.exe' });
    // Sandbox level and additional-roots flag survive the edit untouched.
    expect(patch.workspacePolicy).toEqual({
      defaultRoot: 'C:\\Projects\\Demo',
      defaultSandbox: 'read_only',
      roots: ['C:\\Projects\\Demo'],
      allowAdditionalRoots: false,
    });
  });

  it('moves the root when edited and still keeps the policy flags', () => {
    const input = { ...snapshotToEditInput(SNAPSHOT), workspaceRoot: 'C:\\Projects\\Other' };
    const patch = buildEnvironmentUpdatePatch(input, SNAPSHOT) as {
      workspacePolicy: Record<string, unknown>;
    };
    expect(patch.workspacePolicy.defaultRoot).toBe('C:\\Projects\\Other');
    expect(patch.workspacePolicy.roots).toEqual(['C:\\Projects\\Other']);
    expect(patch.workspacePolicy.defaultSandbox).toBe('read_only');
  });

  it('produces a patch whose fields match what a fresh registration would store', () => {
    const input = snapshotToEditInput(SNAPSHOT);
    const record = buildEnvironmentRecord(input);
    const patch = buildEnvironmentUpdatePatch(input, SNAPSHOT) as Record<string, unknown>;
    for (const field of ['label', 'adapterId', 'executable', 'protocolPreference', 'versionPolicy', 'providerRefs', 'credentialBindings'] as const) {
      expect(patch[field]).toEqual(record[field]);
    }
  });

  it('sends credential bindings only when the form saw them, and clears only on purpose', () => {
    // Bindings reported by the snapshot ride along with the save.
    const seen = buildEnvironmentUpdatePatch(snapshotToEditInput(SNAPSHOT), SNAPSHOT);
    expect(seen.credentialBindings).toEqual({
      ANTHROPIC_API_KEY: 'provider/anthropic-main/api-key',
    });

    // An older Gate's snapshot omits them: the patch must not carry a
    // bindings claim at all — the Gate keeps the stored mapping untouched.
    const unreported: EnvironmentSnapshot = { ...SNAPSHOT, credentialBindings: undefined };
    const blind = buildEnvironmentUpdatePatch(snapshotToEditInput(unreported), unreported);
    expect(blind).not.toHaveProperty('credentialBindings');

    // Removing every row in a bindings-aware form is an explicit clear.
    const cleared = buildEnvironmentUpdatePatch(
      { ...snapshotToEditInput(SNAPSHOT), credentialBindings: {} },
      SNAPSHOT,
    );
    expect(cleared.credentialBindings).toEqual({});
  });
});

describe('buildEnvironmentRecord credential bindings', () => {
  const baseInput = snapshotToEditInput(SNAPSHOT);

  it('trims both sides and stores references, never secret material', () => {
    const record = buildEnvironmentRecord({
      ...baseInput,
      credentialBindings: {
        '  ANTHROPIC_API_KEY ': '  provider/anthropic-main/api-key  ',
      },
    });
    expect(record.credentialBindings).toEqual({
      ANTHROPIC_API_KEY: 'provider/anthropic-main/api-key',
    });
  });

  it('rejects a half-filled binding instead of storing something that resolves to nothing', () => {
    const broken: Record<string, string>[] = [
      { ANTHROPIC_API_KEY: '' },
      { ANTHROPIC_API_KEY: '   ' },
      { '': 'provider/anthropic-main/api-key' },
    ];
    for (const bindings of broken) {
      expect(() => buildEnvironmentRecord({ ...baseInput, credentialBindings: bindings })).toThrow(
        /environment variable name and a vault reference/,
      );
    }
  });

  it('defaults to no bindings when the input says nothing', () => {
    const record = buildEnvironmentRecord({ ...baseInput, credentialBindings: undefined });
    expect(record.credentialBindings).toEqual({});
  });
});

describe('environment edit transport', () => {
  it('routes edits and removals through the environments.update/delete RPC methods', async () => {
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    const client = createEnvironmentClient(async <T,>(method: string, params?: Record<string, unknown>) => {
      calls.push([method, params]);
      return { ok: true } as T;
    });
    await client.update('hermes-local', { executable: { path: 'C:\\fixed\\hermes.exe' } });
    await client.remove('hermes-local');
    expect(calls[0]).toEqual([
      'environments.update',
      { id: 'hermes-local', executable: { path: 'C:\\fixed\\hermes.exe' } },
    ]);
    expect(calls[1]).toEqual(['environments.delete', { id: 'hermes-local' }]);
  });
});
