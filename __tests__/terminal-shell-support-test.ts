import {
  describeShellUnavailable,
  resolveShellSupport,
  type TerminalShellSupport,
} from '@/lib/terminal/shell-support';
import type { GatewayCapabilityGroup, GatewayCapabilitySnapshot } from '@/lib/gateway/types';

function snapshotWith(
  status: GatewayCapabilitySnapshot['status'],
  groups: GatewayCapabilitySnapshot['groups'],
): Pick<GatewayCapabilitySnapshot, 'status' | 'groups'> {
  return { status, groups };
}

function group(
  status: GatewayCapabilityGroup['status'],
  id = 'terminal',
): GatewayCapabilityGroup {
  return { id, label: id === 'terminal' ? 'Terminal' : 'Chat', status };
}

const COMPLETED_READS = ['fresh', 'stale'] as const;

/**
 * The contract for a terminal group the snapshot actually lists, on a
 * completed read. Typed as a `Record` over the status union so tsc fails if a
 * new status is added without deciding what shell support means for it; the
 * runtime keys are the source of the matrix below.
 */
const COMPLETED_READ_VERDICTS: Record<GatewayCapabilityGroup['status'], TerminalShellSupport> = {
  ready: 'ready',
  unavailable: 'unsupported',
  unsupported: 'unsupported',
  // Present, but the status settles nothing about whether a shell exists.
  available: 'unknown',
  unknown: 'unknown',
  'missing-scope': 'unknown',
  warming: 'unknown',
  stale: 'unknown',
  partial: 'unknown',
  unhealthy: 'unknown',
  experimental: 'unknown',
  undeclared: 'unknown',
};

const GROUP_STATUSES = Object.keys(COMPLETED_READ_VERDICTS) as GatewayCapabilityGroup['status'][];

/**
 * The contract when the snapshot lists no terminal group at all, typed over
 * the snapshot-status union for the same reason as the matrix above.
 */
const ABSENT_GROUP_VERDICTS: Record<GatewayCapabilitySnapshot['status'], TerminalShellSupport> = {
  fresh: 'unsupported',
  stale: 'unsupported',
  warming: 'unknown',
  partial: 'unknown',
  offline: 'unknown',
};

const SNAPSHOT_STATUSES = Object.keys(
  ABSENT_GROUP_VERDICTS,
) as GatewayCapabilitySnapshot['status'][];

describe('resolveShellSupport', () => {
  test('terminal group ready means ready, even on a stale snapshot', () => {
    const support = resolveShellSupport(
      snapshotWith('stale', [{ id: 'terminal', label: 'Terminal', status: 'ready' }]),
    );
    expect(support).toBe('ready');
  });

  test('completed snapshot without a terminal group is unsupported', () => {
    expect(resolveShellSupport(snapshotWith('fresh', []))).toBe('unsupported');
    expect(
      resolveShellSupport(
        snapshotWith('fresh', [{ id: 'chat', label: 'Chat', status: 'ready' }]),
      ),
    ).toBe('unsupported');
  });

  test('a not-ready terminal group on a completed snapshot is still unsupported', () => {
    expect(
      resolveShellSupport(
        snapshotWith('stale', [{ id: 'terminal', label: 'Terminal', status: 'unsupported' }]),
      ),
    ).toBe('unsupported');
  });

  test('warming, partial, and offline snapshots refuse to claim either way', () => {
    for (const status of ['warming', 'partial', 'offline'] as const) {
      expect(
        resolveShellSupport(snapshotWith(status, [{ id: 'terminal', label: 'Terminal', status: 'unsupported' }])),
      ).toBe('unknown');
    }
  });

  test('every status matrix is exhaustive over the real unions', () => {
    // Guards the matrices themselves: a status added to either union must be
    // added to its Record (tsc) and therefore shows up here (runtime).
    expect([...GROUP_STATUSES].sort()).toEqual([
      'available',
      'experimental',
      'missing-scope',
      'partial',
      'ready',
      'stale',
      'unavailable',
      'undeclared',
      'unhealthy',
      'unknown',
      'unsupported',
      'warming',
    ]);
    expect([...SNAPSHOT_STATUSES].sort()).toEqual([
      'fresh',
      'offline',
      'partial',
      'stale',
      'warming',
    ]);
  });

  test('a completed read resolves each listed status per the typed matrix', () => {
    for (const snapshotStatus of COMPLETED_READS) {
      for (const status of GROUP_STATUSES) {
        expect([
          snapshotStatus,
          status,
          resolveShellSupport(snapshotWith(snapshotStatus, [group(status)])),
        ]).toEqual([snapshotStatus, status, COMPLETED_READ_VERDICTS[status]]);
      }
    }
  });

  test('an incomplete snapshot never claims no shell, whatever the group says', () => {
    for (const snapshotStatus of SNAPSHOT_STATUSES) {
      const completed = snapshotStatus === 'fresh' || snapshotStatus === 'stale';
      if (completed) continue;
      for (const status of GROUP_STATUSES) {
        expect([
          snapshotStatus,
          status,
          resolveShellSupport(snapshotWith(snapshotStatus, [group(status)])),
        ]).toEqual([snapshotStatus, status, status === 'ready' ? 'ready' : 'unknown']);
      }
    }
  });

  test('the documented absent-group rule follows the typed matrix', () => {
    for (const snapshotStatus of SNAPSHOT_STATUSES) {
      expect([
        snapshotStatus,
        resolveShellSupport(snapshotWith(snapshotStatus, [group('ready', 'chat')])),
      ]).toEqual([snapshotStatus, ABSENT_GROUP_VERDICTS[snapshotStatus]]);
    }
  });

  test('a scope-limited terminal group is unknown, not "no shell" (VS-004)', () => {
    // QUALITY-SCAN-2026-10-11: terminal needs operator.write, so a token that
    // cannot ask must not be told the gateway has no shell.
    for (const snapshotStatus of COMPLETED_READS) {
      expect([
        snapshotStatus,
        resolveShellSupport(snapshotWith(snapshotStatus, [group('missing-scope')])),
      ]).toEqual([snapshotStatus, 'unknown']);
    }
  });

  test('a still-warming or partially probed terminal group is unknown (VS-004)', () => {
    for (const status of ['warming', 'partial', 'unknown', 'available'] as const) {
      expect([
        status,
        resolveShellSupport(snapshotWith('fresh', [group(status)])),
      ]).toEqual([status, 'unknown']);
    }
  });

  test('a completed read that states absence stays unsupported (VS-004)', () => {
    for (const status of ['unavailable', 'unsupported'] as const) {
      for (const snapshotStatus of COMPLETED_READS) {
        expect([
          snapshotStatus,
          status,
          resolveShellSupport(snapshotWith(snapshotStatus, [group(status)])),
        ]).toEqual([snapshotStatus, status, 'unsupported']);
      }
    }
  });

  test('the verdict comes from the snapshot status, not wall-clock age', () => {
    // Freshness is classified upstream into `status`; an ancient `checkedAt`
    // that already reads fresh/stale must resolve exactly like a new one, and
    // the module must not consult the clock itself.
    const ancient: GatewayCapabilitySnapshot = {
      checkedAt: 0,
      status: 'stale',
      groups: [group('missing-scope')],
      methods: {},
      scopes: [],
    };
    const future: GatewayCapabilitySnapshot = {
      checkedAt: Number.MAX_SAFE_INTEGER,
      status: 'fresh',
      groups: [group('unsupported')],
      methods: {},
      scopes: [],
    };
    expect(resolveShellSupport(ancient)).toBe('unknown');
    expect(resolveShellSupport(future)).toBe('unsupported');
  });
});

describe('describeShellUnavailable', () => {
  test('unsupported states the fact and names the gateway', () => {
    const copy = describeShellUnavailable('unsupported', 'ethanspc');
    expect(copy.title).toBe('No shell on this gateway');
    expect(copy.description).toContain('ethanspc');
    expect(copy.description).toContain('does not offer');
  });

  test('unknown defers judgement instead of claiming absence', () => {
    const copy = describeShellUnavailable('unknown', 'ethanspc');
    expect(copy.title).not.toBe('No shell on this gateway');
    expect(copy.description).toContain('Still confirming');
    expect(copy.description).toContain('ethanspc');
  });

  test('a scope-limited gateway gets the "not confirmed" copy, not the no-shell copy', () => {
    const support = resolveShellSupport(snapshotWith('fresh', [group('missing-scope')]));
    if (support === 'ready') throw new Error('a scope-limited group must not read as ready');
    const copy = describeShellUnavailable(support, 'ethanspc');
    expect(copy.title).toBe('Shell not confirmed yet');
    expect(copy.description).not.toContain('does not offer');
    expect(copy.description).toContain('ethanspc');
  });
});
