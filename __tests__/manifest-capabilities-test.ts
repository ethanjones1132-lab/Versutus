import {
  manifestCapabilityKinds,
  manifestCapabilityInstances,
  manifestDynamicCommands,
  type GatewayManifest,
} from '@/lib/portal/manifest';

function manifestWith(extra: Partial<GatewayManifest>): GatewayManifest {
  return { manifest: 'versutus-gateway/v1', kind: 'versutus-gate', ...extra } as GatewayManifest;
}

const CRON_KIND = {
  id: 'cron',
  label: 'Scheduled jobs',
  family: 'cron',
  configFields: [{ key: 'schedule', label: 'Schedule', type: 'string', required: true }],
};

const STANDUP_INSTANCE = {
  id: 'standup',
  kind: 'cron',
  label: 'Standup reminder',
  family: 'cron',
  manifestEntry: { id: 'standup', schedule: '0 9 * * 1-5' },
  commands: [
    { slash: '/standup', description: 'Run the standup job now', method: 'standup.run', danger: 'write' },
  ],
};

describe('manifestCapabilityKinds', () => {
  test('returns well-formed kinds', () => {
    const kinds = manifestCapabilityKinds(manifestWith({ capabilityKinds: [CRON_KIND] } as any));
    expect(kinds).toHaveLength(1);
    expect(kinds[0].id).toBe('cron');
  });

  test('returns empty when the field is absent — a non-Gate manifest stays valid', () => {
    expect(manifestCapabilityKinds(manifestWith({}))).toEqual([]);
  });

  test('drops a malformed kind without dropping its well-formed siblings', () => {
    const kinds = manifestCapabilityKinds(
      manifestWith({ capabilityKinds: [{ id: '' }, CRON_KIND, { label: 'no id' }] } as any),
    );
    expect(kinds.map((kind) => kind.id)).toEqual(['cron']);
  });

  test('drops a kind whose configFields is not an array', () => {
    const kinds = manifestCapabilityKinds(
      manifestWith({ capabilityKinds: [{ ...CRON_KIND, configFields: 'nope' }] } as any),
    );
    expect(kinds).toEqual([]);
  });
});

describe('manifestCapabilityInstances', () => {
  test('returns well-formed instances', () => {
    const instances = manifestCapabilityInstances(
      manifestWith({ capabilityInstances: [STANDUP_INSTANCE] } as any),
    );
    expect(instances).toHaveLength(1);
    expect(instances[0]).toMatchObject({ id: 'standup', kind: 'cron', family: 'cron' });
  });

  test('returns empty when the field is absent', () => {
    expect(manifestCapabilityInstances(manifestWith({}))).toEqual([]);
  });

  test('drops an instance missing id, kind, or family', () => {
    const instances = manifestCapabilityInstances(
      manifestWith({
        capabilityInstances: [
          STANDUP_INSTANCE,
          { id: 'x', kind: 'cron', label: 'no family' },
          { kind: 'cron', label: 'no id', family: 'cron' },
        ],
      } as any),
    );
    expect(instances.map((instance) => instance.id)).toEqual(['standup']);
  });
});

describe('manifestDynamicCommands', () => {
  test('flattens commands across instances', () => {
    const commands = manifestDynamicCommands(
      manifestWith({
        capabilityInstances: [
          STANDUP_INSTANCE,
          {
            id: 'weekly',
            kind: 'cron',
            label: 'Weekly',
            family: 'cron',
            commands: [
              { slash: '/weekly', description: 'Run weekly', method: 'weekly.run', danger: 'safe' },
            ],
          },
        ],
      } as any),
    );
    expect(commands.map((command) => command.slash)).toEqual(['/standup', '/weekly']);
  });

  test('returns empty for instances that contribute no commands', () => {
    const commands = manifestDynamicCommands(
      manifestWith({
        capabilityInstances: [{ id: 'nvidia', kind: 'provider', label: 'NVIDIA', family: 'models' }],
      } as any),
    );
    expect(commands).toEqual([]);
  });

  test('drops a malformed command — a bad slash, method, or danger never reaches the palette', () => {
    const commands = manifestDynamicCommands(
      manifestWith({
        capabilityInstances: [
          {
            id: 'standup',
            kind: 'cron',
            label: 'Standup',
            family: 'cron',
            commands: [
              { slash: 'no-leading-slash', description: 'x', method: 'a.b', danger: 'safe' },
              { slash: '/nomethod', description: 'x', danger: 'safe' },
              { slash: '/baddanger', description: 'x', method: 'a.b', danger: 'catastrophic' },
              { slash: '/good', description: 'x', method: 'a.b', danger: 'safe' },
            ],
          },
        ],
      } as any),
    );
    expect(commands.map((command) => command.slash)).toEqual(['/good']);
  });
});
