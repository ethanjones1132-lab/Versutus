import { describeShellUnavailable, resolveShellSupport } from '@/lib/terminal/shell-support';
import type { GatewayCapabilitySnapshot } from '@/lib/gateway/types';

function snapshotWith(
  status: GatewayCapabilitySnapshot['status'],
  groups: GatewayCapabilitySnapshot['groups'],
): Pick<GatewayCapabilitySnapshot, 'status' | 'groups'> {
  return { status, groups };
}

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
});
