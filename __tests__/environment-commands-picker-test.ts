import {
  DEFAULT_LAUNCHER_OPERATIONS,
  operationNeedsPromptInput,
  resolveLauncherOperations,
} from '@/lib/gateway/environment-operations';

describe('environment command catalog picker', () => {
  it('lists the machine-readable catalog entries in order', () => {
    expect(
      resolveLauncherOperations({
        prompt: { machineReadable: true, risk: 'workspace_write' },
        status: { machineReadable: true, risk: 'read' },
        interactive: { machineReadable: false, risk: 'credential' },
      }),
    ).toEqual(['prompt', 'status']);
  });

  it('offers exec for Codex environments instead of the hardcoded prompt', () => {
    expect(
      resolveLauncherOperations({
        exec: { machineReadable: true, risk: 'workspace_write' },
        status: { machineReadable: true, risk: 'read' },
        interactive: { machineReadable: false, risk: 'credential' },
      }),
    ).toEqual(['exec', 'status']);
  });

  it('never offers the non-machine-readable interactive operation', () => {
    const offered = resolveLauncherOperations({
      interactive: { machineReadable: false, risk: 'credential' },
    });
    expect(offered).not.toContain('interactive');
  });

  it('keeps prompt/status when the catalog cannot be read', () => {
    expect(resolveLauncherOperations(null)).toEqual([...DEFAULT_LAUNCHER_OPERATIONS]);
    expect(resolveLauncherOperations(undefined)).toEqual([...DEFAULT_LAUNCHER_OPERATIONS]);
    expect(resolveLauncherOperations({})).toEqual([...DEFAULT_LAUNCHER_OPERATIONS]);
    expect(resolveLauncherOperations({ interactive: { machineReadable: false } })).toEqual([
      ...DEFAULT_LAUNCHER_OPERATIONS,
    ]);
  });

  it('asks for prompt text only for prompt-taking operations', () => {
    expect(operationNeedsPromptInput('prompt')).toBe(true);
    expect(operationNeedsPromptInput('exec')).toBe(true);
    expect(operationNeedsPromptInput('status')).toBe(false);
  });
});
